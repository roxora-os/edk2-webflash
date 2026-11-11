# xzwasm.wasm

The WebAssembly XZ decoder from the npm package `xzwasm` 0.1.2
(https://github.com/SteveSanderson/xzwasm), taken from the base64 data URL in
`dist/package/xzwasm.js` and stored here as a plain file. Only the wasm is
used; `src/xz.js` is the JavaScript side.

- xzwasm: (c) Steve Sanderson, MIT License.
- xz-embedded (the decoder inside): Lasse Collin and Igor Pavlov, public domain.
- walloc (the allocator inside): (c) 2020 Igalia, S.L., MIT License.

Built with `-DXZ_DEC_CONCATENATED -DXZ_USE_CRC64` and a 64 MiB dictionary
limit, so it decodes what `xz -9` writes with the default CRC64 or CRC32
check. Files made with `--check=sha256` are rejected (`XZ_UNSUPPORTED_CHECK`).

sha256 of this file:
`bc6e1f81bbcad966562bbdd8fb0849a16e7db104ce68a3053bf81a1c0870146a`
(npm tarball xzwasm-0.1.2.tgz:
`f6bc6836e29a131fbbc6c79fe08117943178c057aba8f38767647807cb47eca3`).
