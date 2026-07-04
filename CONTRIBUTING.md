# Contributing

Thanks for helping improve the workspace.

Please keep changes small and explain the user-facing behavior in the pull request. Run `npm run build` before opening a pull request.

Storage-specific code belongs in `storage.mjs`. If you add another backend, implement the same storage methods used by the server and document its environment variables in `README.md`.

Do not commit `.env`, database files, generated `dist/` output, or user drawings.
