// A small native Windows Forms app used as a controlled target for the Windows adapter. Nothing here touches the
// network or disk; it only shows what it was given.
using System;
using System.Drawing;
using System.Windows.Forms;

class Fixture : Form
{
    TextBox name = new TextBox { Name = "nameBox", AccessibleName = "Name", Left = 20, Top = 40, Width = 220 };
    TextBox secret = new TextBox { Name = "pwBox", AccessibleName = "Secret", Left = 20, Top = 80, Width = 220, UseSystemPasswordChar = true };
    CheckBox loud = new CheckBox { Name = "loudBox", Text = "Shout", Left = 20, Top = 115, Width = 120 };
    ComboBox size = new ComboBox { Name = "sizeBox", AccessibleName = "Size", Left = 20, Top = 150, Width = 220, DropDownStyle = ComboBoxStyle.DropDownList };
    ListBox colors = new ListBox { Name = "colorList", AccessibleName = "Colors", Left = 20, Top = 190, Width = 220, Height = 60 };
    Button go = new Button { Name = "goButton", Text = "Go", Left = 20, Top = 260, Width = 100 };
    Label result = new Label { Name = "resultLabel", Text = "Ready", Left = 20, Top = 300, Width = 360, Height = 40 };

    Fixture()
    {
        Text = "Motive Fixture";
        ClientSize = new Size(400, 360);
        size.Items.AddRange(new object[] { "Small", "Medium", "Large" });
        size.SelectedIndex = 0;
        colors.Items.AddRange(new object[] { "Red", "Green", "Blue" });
        var menu = new MenuStrip { Name = "mainMenu" };
        var actions = new ToolStripMenuItem("Actions") { Name = "actionsMenu" };
        var clear = new ToolStripMenuItem("Clear") { Name = "clearItem" };
        clear.Click += (s, e) => { name.Text = ""; secret.Text = ""; loud.Checked = false; size.SelectedIndex = 0; colors.ClearSelected(); result.Text = "Cleared"; };
        actions.DropDownItems.Add(clear);
        menu.Items.Add(actions);
        MainMenuStrip = menu;
        go.Click += (s, e) =>
            result.Text = "Name=" + name.Text + ";Loud=" + loud.Checked + ";Size=" + size.Text + ";Color=" + (colors.SelectedItem ?? "none") + ";Secret=" + secret.Text.Length;
        Controls.AddRange(new Control[] { menu, name, secret, loud, size, colors, go, result });
    }

    [STAThread]
    static void Main() { Application.EnableVisualStyles(); Application.Run(new Fixture()); }
}
