# Third-party files in this folder

Served by the booth itself so that skin retouch never depends on a CDN or on the venue's network.

| File                                         | From                                                                                                                         | Licence                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `mediapipe/vision_wasm_nosimd_internal.js`   | npm `@mediapipe/tasks-vision` 0.10.21, `wasm/` (unchanged)                                                                   | Apache License, Version 2.0 |
| `mediapipe/vision_wasm_nosimd_internal.wasm` | npm `@mediapipe/tasks-vision` 0.10.21, `wasm/` (unchanged)                                                                   | Apache License, Version 2.0 |
| `models/face_landmarker.task`                | https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task               | Apache License, Version 2.0 |
| `models/blaze_face_short_range.tflite`       | https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite | Apache License, Version 2.0 |

MediaPipe is Copyright The MediaPipe Authors and is licensed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0). The files are redistributed unchanged; their SHA-256
hashes are held by `tests/unit/retouch-assets.test.ts`.

The version is pinned to 0.10.21 on purpose: it is a release with a non-SIMD WebAssembly build,
which Safari 15 (iPad mini 4) needs. See `docs/research/skin-retouch-audit.md`.

`samples/` holds the test photographs of the lab page; their sources and licences are in
`samples/manifest.json` and `samples/README.md`.
