# Portable development workspace and private credentials

Date: 2026-10-31. Status: accepted for owner-authorized workspace maintenance.

Copied Windows dependency junctions referred back to C:/Dev, while ignored credentials and unpublished work were not covered by GitHub. Keep the products as independent repositories. Centralize development/deployment credentials and test profiles as restricted real files in an external private root, configurable by path environment variables. Keep installed-app live identities and server credentials in their OS/server-managed locations.

Back up unique local data in an encrypted snapshot on another physical disk before repair/cleanup. Publish reviewed source and useful documentation only, never credentials/ignored private state. Use source-relative paths and an explicit private-root override rather than compatibility directory junctions. Reinstall dependencies when necessary after platform/toolchain moves; do not claim DPAPI identities are cross-machine portable.

View and Remote use pnpm hoisted copied dependencies and injected workspace packages with deduplication-to-links disabled; build/typecheck/test/dev workflows synchronize those copies. This uses more disk than pnpm's linked layout, avoiding external directory dependencies. Motive keeps its existing npm lockfiles. No production architecture, runtime authority or feature milestone changes are implied.

See ../workspace-handoff.md for current paths, commands and remaining acceptance gates.
