//! Reads the text shown in one window with the OCR engine that ships with Windows (Windows.Media.Ocr, on-device, no
//! model download, no network). The window is rendered with PrintWindow, so only that window's own pixels are read,
//! never other windows that overlap it and never the rest of the screen.
use serde_json::{json, Value};
use uiautomation::UIElement;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

/// The executable name (without folders) of a process, lower-cased; empty when it cannot be opened (for example elevated).
pub fn process_name(pid: u32) -> String {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return String::new();
        }
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        full.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase()
    }
}

/// Physical pixels make OCR sharper and keep rectangles in the same units the window reports. Safe to call repeatedly.
pub fn dpi_aware() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

struct Pixels {
    width: i32,
    height: i32,
    bgra: Vec<u8>,
}

fn capture(hwnd: HWND) -> Result<Pixels, String> {
    unsafe {
        let mut r = RECT::default();
        GetWindowRect(hwnd, &mut r).map_err(|e| format!("GetWindowRect: {e}"))?;
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        if w <= 0 || h <= 0 || w > 8000 || h > 8000 {
            return Err(format!("window size {w}x{h} cannot be read"));
        }
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(dc, HGDIOBJ(bmp.0));
        // PW_RENDERFULLCONTENT (2) also renders DirectX/WebView content.
        let drawn = PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(2)).as_bool();
        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() };
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = GetDIBits(dc, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
        SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        if !drawn {
            return Err("the window refused to render itself (it may be elevated or protected)".into());
        }
        if lines == 0 {
            return Err("could not copy the window's pixels".into());
        }
        // GDI leaves alpha at 0; OCR wants opaque pixels.
        for px in buf.chunks_exact_mut(4) {
            px[3] = 255;
        }
        Ok(Pixels { width: w, height: h, bgra: buf })
    }
}

/// Windows OCR reads small UI text far better when it is larger; scale by whole steps while it still fits the engine limit.
fn upscale(p: Pixels, max: i32) -> (Pixels, i32) {
    let k = if p.width * 3 <= max && p.height * 3 <= max { 3 } else if p.width * 2 <= max && p.height * 2 <= max { 2 } else { 1 };
    if k == 1 {
        return (p, 1);
    }
    let (w, h) = (p.width * k, p.height * k);
    let mut out = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let src = (((y / k) * p.width + (x / k)) * 4) as usize;
            let dst = ((y * w + x) * 4) as usize;
            out[dst..dst + 4].copy_from_slice(&p.bgra[src..src + 4]);
        }
    }
    (Pixels { width: w, height: h, bgra: out }, k)
}

fn crop(p: Pixels, rect: &Value) -> Result<(Pixels, i32, i32), String> {
    let get = |k: &str| rect.get(k).and_then(|v| v.as_i64());
    let (Some(l), Some(t), Some(w), Some(h)) = (get("left"), get("top"), get("width"), get("height")) else {
        return Ok((p, 0, 0));
    };
    let (l, t) = (l.clamp(0, p.width as i64 - 1) as i32, t.clamp(0, p.height as i64 - 1) as i32);
    let (w, h) = ((w as i32).clamp(1, p.width - l), (h as i32).clamp(1, p.height - t));
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for row in t..t + h {
        let start = ((row * p.width + l) * 4) as usize;
        out.extend_from_slice(&p.bgra[start..start + (w * 4) as usize]);
    }
    Ok((Pixels { width: w, height: h, bgra: out }, l, t))
}

pub fn run(win: &UIElement, rect: &Value) -> Result<Value, String> {
    dpi_aware();
    let handle = win.get_native_window_handle().map_err(|e| format!("window handle: {e}"))?;
    let hwnd: HWND = handle.into();
    let (cropped, off_x, off_y) = crop(capture(hwnd)?, rect)?;
    let max = OcrEngine::MaxImageDimension().unwrap_or(4096) as i32;
    let (pixels, k) = upscale(cropped, max);
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|e| format!("no OCR language is installed for this user: {e}"))?;
    if pixels.width > max || pixels.height > max {
        return Err(format!("the region {}x{} is larger than the OCR limit of {max}; pass a smaller rect", pixels.width, pixels.height));
    }
    let bitmap = SoftwareBitmap::Create(BitmapPixelFormat::Bgra8, pixels.width, pixels.height).map_err(|e| e.to_string())?;
    let writer = DataWriter::new().map_err(|e| e.to_string())?;
    writer.WriteBytes(&pixels.bgra).map_err(|e| e.to_string())?;
    let buffer = writer.DetachBuffer().map_err(|e| e.to_string())?;
    bitmap.CopyFromBuffer(&buffer).map_err(|e| e.to_string())?;
    let result = engine.RecognizeAsync(&bitmap).map_err(|e| e.to_string())?.join().map_err(|e| format!("recognition failed: {e}"))?;
    let lines = result.Lines().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for line in lines {
        let text = line.Text().map_err(|e| e.to_string())?.to_string();
        let words = line.Words().map_err(|e| e.to_string())?;
        let (mut l, mut t, mut r, mut b) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for word in words {
            let bb = word.BoundingRect().map_err(|e| e.to_string())?;
            l = l.min(bb.X as f64);
            t = t.min(bb.Y as f64);
            r = r.max((bb.X + bb.Width) as f64);
            b = b.max((bb.Y + bb.Height) as f64);
        }
        if l <= r {
            out.push(json!({"text": text, "rect": {"left": (l as i32) / k + off_x, "top": (t as i32) / k + off_y, "width": ((r - l) as i32) / k, "height": ((b - t) as i32) / k}}));
        } else {
            out.push(json!({"text": text}));
        }
    }
    Ok(json!({"lines": out, "width": pixels.width / k, "height": pixels.height / k}))
}
