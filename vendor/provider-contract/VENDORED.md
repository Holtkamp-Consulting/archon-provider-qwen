# Vendored `@archon/provider-contract`

`@archon/provider-contract` is not published to npm. This directory is a copy of
`packages/provider-contract` from [coleam00/Archon](https://github.com/coleam00/Archon):

- Tag: `v0.14.0`
- Commit: `8def159a6b2c23e832a5283b4131cfffd9af9344`
- Provider plugin protocol: `3` (`PROVIDER_PLUGIN_PROTOCOL` in `src/plugin/wire.ts`)
- License: MIT (see `LICENSE` in this directory)

Changes from upstream, nothing else:

- Removed the upstream tests (`*.test.ts`), `src/scripts/`, `src/fixtures/`,
  `src/plugin/fixtures/acp.ts`, `src/plugin/fixtures/provider.ts`, the protocol-3 baseline
  snapshot, `bunfig.toml` and `tsconfig.json` (they depend on the Archon monorepo).
- `package.json` reduced to the exports and the runtime dependency (`zod`).

To update, copy `packages/provider-contract/src` and `schema/` from the new Archon tag, apply
the same removals, and update the commit above. A protocol bump requires a new plugin release.
