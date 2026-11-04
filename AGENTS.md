# Beacon Motive agent entry point

Read README.md, docs/workspace.md, docs/roadmap.md and
docs/development-status.md before planning or running development commands.
The roadmap describes approved scope; development-status.md distinguishes
recorded validation from remaining device and release gates. Check Git status,
the current branch/upstream and GitHub activity before choosing the next slice.
Use a feature branch. Do not infer deployment or privileged-machine authority
from historical handoffs or another Beacon product's permissions.

This is the independent local automation product at D:/Dev/beacon-motive.
The suite overview is D:/Dev/README.md and shared workstation rules are in
D:/Dev/AGENTS.md when available. View and Remote own separate repositories,
databases and processes. Never reclaim a port by stopping an unknown owner.
Do not inspect D:/0 - Do Not Touch or unrelated personal folders.

Dot-source scripts/Enter-Workspace.ps1 to select existing private state under
the configurable external root, currently D:/Beacon-Secrets/motive/local.
Never print, commit or silently replace tokens, workflow secrets or recordings.
Keep loopback authentication, app/host/directory scopes, redaction, visible
recording, explicit review and emergency Stop. A Remote connector requires its
own credentials and authorization. Model repair remains opt-in and reviewed.

Read docs/testing.md before tests. npm run typecheck and npm run test:ci are
the routine deterministic checks; npm test includes application-driving tests
and must not be launched casually against the owner's desktop. Phone/model
checks are explicitly opt-in. Do not run audio tests. Hardware, clean-machine
installation and human-operated teaching require separate observed evidence.

Update the roadmap/status and relevant setup documentation with each completed
slice. Keep useful guidance in Git rather than relying on a Codex chat. Git
does not preserve ignored private state; encrypted recovery instructions are
at C:/Users/Saiha/Beacon-Backups/README.md. DPAPI recovery depends on the original
Windows user/machine. Do not create loose archives or duplicate workspaces.
