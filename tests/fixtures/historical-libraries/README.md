# Historical library fixtures

Each database was initialized by the original LibraryStore from its release
source, using Node SQLite. Synthetic tracks, playlist items, preferences,
playback events and settings were then inserted into the resulting schema.
No real profile data, paths, tokens or audio are included.

| Fixture | Source commit | SQLite schema |
| --- | --- | --- |
| 0.8.0 | c3189eb5e9e2e956f0d00f5def45d1331f0318da | 12 |
| 0.9.0-yandex | 9e1ae0d0c14cec7723d9f3a7665d62a3ff1b1184 | 13 |
| 0.10.0 | c1703bab70a27a03b8205bccb29f7d20b3fa8986 | 14 |
