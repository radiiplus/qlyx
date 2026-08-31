# Qlyx

Qlyx is a local development bridge that lets AI chat agents work with authorized
project files, terminal commands, persistent workspace state, and browser pages.
It consists of a Node.js workspace daemon and a Chromium extension for supported
AI chat providers.

## Components

- [`app/`](app/README.md) contains the `qlyx` CLI, shared daemon, workspace tools,
  persistent `.agent/` state, and the npm package.
- [`ext/`](ext/README.md) contains the Manifest V3 Chromium extension and its
  browser/session controls.

## Install

```bash
npm install --global qlyx
qlyx init
```

Build the unpacked browser extension with:

```bash
cd ext
npm install
npm run build
```

Then load `ext/` as an unpacked extension in Chromium and reload it after each
extension update.

See the component READMEs for configuration, commands, protocol details, and
development instructions.
