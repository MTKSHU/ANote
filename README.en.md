# ANote

English · [简体中文](README.md) · [Project website](https://mtkshu.github.io/ANote/) · [Releases](https://github.com/MTKSHU/ANote/releases)

ANote is a self-hosted notes and knowledge workspace for individuals, research groups and teams. Organize notes into libraries and folders, work together in a rich text editor, discuss passages, restore earlier versions and sync managed Markdown files with a local folder.

The web and desktop interfaces support English and Simplified Chinese. ANote follows your browser language by default. You can change it on the sign-in screen or under **Settings → Account and preferences**. Changing the interface language does not translate note content or names you have entered.

## Features

- **Writing and organization:** nested folders, tags, search, drag-and-drop ordering, tables, to-do lists, syntax-highlighted code, LaTeX, Mermaid and visual mind maps.
- **Attachments:** upload, paste or drop images, audio, video and files directly into notes. Image comparison and previews for supported 3D formats are included.
- **Collaboration:** real-time editing, paragraph comments, version history, team permissions and revocable read-only public links.
- **Desktop and offline use:** a local personal mode without an account or server, plus cached team notes and two-way managed Markdown sync.
- **Administration:** local accounts, OIDC sign-in, team invitations, trash and light or dark themes.
- **MCP integrations:** authorized AI clients can search notes, read comments, prepare edits and upload attachments. Changes are reviewed before they are saved.

Personal notes are private by default. Team members can read and comment on content they have access to; editing another person's notes requires permission. Platform administrator status does not grant access to private notes.

## Installation

The server runs with Docker Engine and Compose V2 and uses PostgreSQL 17. Run these commands from the repository root:

```sh
docker run --rm --user 0:0 \
  -v "$PWD:/workspace" -w /workspace \
  node:22-bookworm node deploy/init-env.mjs

docker compose --env-file deploy/.env \
  -f deploy/compose.yaml -p anote up -d --build --wait
```

The configuration script creates a local `deploy/.env` file with random passwords and a configuration encryption key. It leaves an existing file intact. Open <http://127.0.0.1:3100> and sign in as `admin` using the file's `ADMIN_PASSWORD` value.

The default listener is local to the host. Set `ANOTE_BIND_IP` in the environment file for LAN access, and use `ANOTE_PORT` to change the port. The [deployment guide](deploy/README.md) covers TrueNAS datasets, custom data folders, reverse proxies and maintenance.

Manage the site name, public URL and authentication under **Settings → Platform administration**. OIDC uses your own identity provider; local accounts work without one. See the [configuration reference](docs/configuration.md) for details.

## Desktop client

The desktop app offers local personal notes and a team connection. Personal mode stores notes, attachments and history in a folder you choose. Connecting to a team never uploads those notes automatically. Team mode connects to your server and isolates caches and sync folders by account and server.

The current desktop preview is **0.5.0**. Binary packages are not stored in this repository. Maintainers can generate Linux, Windows and macOS packages with:

```sh
bash scripts/package-desktop.sh
```

Packages are written to `artifacts/releases/`. The release workflow currently produces unsigned portable archives. Windows and macOS require testing on those operating systems. See the [desktop guide](docs/desktop.md) for usage and sync behavior.

## MCP connections

**Settings → AI integrations** shows your server's MCP address, such as `https://notes.example.org/mcp`. A client that supports remote MCP OAuth signs in through a browser and uses the permissions you grant. Connections can be revoked at any time. Unsynced local personal notes are not available through the remote server.

The [MCP reference](docs/mcp.md) describes tools, permissions, edit previews and attachment transfers.

## Development

ANote uses TypeScript, React, Tiptap, Yjs, NestJS and Electron. Dependencies and development checks run in Docker. See the [development guide](docs/development.md) for commands and repository structure, and the [internationalization guide](docs/internationalization.md) for maintaining translations.

The remaining reference documents are currently written in Chinese: [deployment](deploy/README.md), [configuration](docs/configuration.md), [editor](docs/editor.md), [desktop](docs/desktop.md), [architecture](docs/architecture.md) and [naming](docs/naming.md).

## License

ANote is licensed under the [Apache License 2.0](LICENSE), which permits use, modification and redistribution, including commercial use, subject to its terms. Third-party components retain their own licenses and notices.
