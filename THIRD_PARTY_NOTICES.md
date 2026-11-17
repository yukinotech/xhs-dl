# Protocol research provenance

The TypeScript implementation in `src/` is written for this project. It does not
load or redistribute the reference repositories' runtime code, obfuscated SDKs,
browser engines, Python packages, Go programs, or remote signing services.

Wire-protocol fields, constants, endpoint paths, framing and cryptographic
transformations were studied against these local snapshots, locked in
`references-lock.json`:

- cv-cat/Spider_XHS, 23dab803a0465e35e01cf87137353a900b47e93d:
  `apis/xhs_pc_login_apis.py`, `xhs_utils/xhs_core/js/mns.js`,
  `xs_common.js`, and `xhs_utils/xhs_pc/js/web_ssk.js`. The local implementation
  includes documented wire constants (alphabets, short keystream prefixes,
  public key and stage values), not a vendored copy of these source files.
- tamnd/xiaohongshu-cli, b60f9a384ed32d002aaacbbff95fedb2bdc96682
  (Apache-2.0): reference for current-user semantics and anonymous device fields.
- ReaJason/xhs, f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0 (MIT):
  reference for SMS and QR endpoint sequencing.

`tests/fixtures/signatures.json` contains synthetic offline protocol test vectors
computed against the locked research snapshot. They contain no account data and
are not proof of live login success. No reference fingerprint templates or
server-issued executable scripts are distributed or executed.

Third-party npm dependency licenses are provided by their respective packages.
This notice records research provenance; it does not relicense upstream work or
assert that the private platform protocol is stable.
