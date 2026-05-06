# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.71.2](https://github.com/Studio-Saelix/sencho/compare/v0.71.1...v0.71.2) (2026-05-06)


### Fixed

* harden MonitorService evaluation loop ([#942](https://github.com/Studio-Saelix/sencho/issues/942)) ([13cb49c](https://github.com/Studio-Saelix/sencho/commit/13cb49ce3ab59eeb649362a5a88c180276284762))

## [0.71.1](https://github.com/Studio-Saelix/sencho/compare/v0.71.0...v0.71.1) (2026-05-06)


### Fixed

* suppress ERROR logging for missing .env files in image update scan ([#936](https://github.com/Studio-Saelix/sencho/issues/936)) ([72b6cdd](https://github.com/Studio-Saelix/sencho/commit/72b6cdd0a3afe72ec332c71a2f45000aee957adc))

## [0.71.0](https://github.com/Studio-Saelix/sencho/compare/v0.70.0...v0.71.0) (2026-05-06)


### Added

* **dashboard:** replace duplicate Recent Activity card with Fleet Heartbeat / Stack Restart Map ([#932](https://github.com/Studio-Saelix/sencho/issues/932)) ([775fab7](https://github.com/Studio-Saelix/sencho/commit/775fab7d6451c306e9930bf2c8ec486add8f6a87))
* implement file explorer context menus and dialogs ([#934](https://github.com/Studio-Saelix/sencho/issues/934)) ([0c3ce4b](https://github.com/Studio-Saelix/sencho/commit/0c3ce4b22431441943ea7feff1fdbb996d77befb))
* open security basics, manual fleet ops, and basic fleet management to Community ([#930](https://github.com/Studio-Saelix/sencho/issues/930)) ([ecf4dd5](https://github.com/Studio-Saelix/sencho/commit/ecf4dd5d52bb56521e9196d621ddb63c25daf67f))
* **sidebar:** filter toggle + action button padding fix ([#933](https://github.com/Studio-Saelix/sencho/issues/933)) ([166ba21](https://github.com/Studio-Saelix/sencho/commit/166ba21ff195315e80352a3d199808c6a6071d77))


### Fixed

* add CodeQL barrier model for sanitizeForLog against log injection ([#935](https://github.com/Studio-Saelix/sencho/issues/935)) ([0dcf309](https://github.com/Studio-Saelix/sencho/commit/0dcf309c48e527bbe82237ba0e440c86c9b4c8fb))

## [0.70.0](https://github.com/Studio-Saelix/sencho/compare/v0.69.3...v0.70.0) (2026-05-05)


### Added

* **resources:** add image details sheet with layer history ([#925](https://github.com/Studio-Saelix/sencho/issues/925)) ([7e5dc2d](https://github.com/Studio-Saelix/sencho/commit/7e5dc2d9ea4f1e1e458516b5bb4fc62a797c8ee3))
* **volumes:** add read-only volume browser ([#926](https://github.com/Studio-Saelix/sencho/issues/926)) ([49d775c](https://github.com/Studio-Saelix/sencho/commit/49d775c61feece1ca4c5f1ea649df857a4b3d226))


### Fixed

* **frontend:** align sidebar brand box with top nav chrome ([#928](https://github.com/Studio-Saelix/sencho/issues/928)) ([6f45a3b](https://github.com/Studio-Saelix/sencho/commit/6f45a3b7880caecbb693ee8c47f282a90435f378))
* **frontend:** tighten bell notification panel toolbar ([#929](https://github.com/Studio-Saelix/sencho/issues/929)) ([a85af40](https://github.com/Studio-Saelix/sencho/commit/a85af40cb5ed572564308bb2791ff1ba3bef0863))

## [0.69.3](https://github.com/Studio-Saelix/sencho/compare/v0.69.2...v0.69.3) (2026-05-04)


### Fixed

* **ci:** create posts dir before writing scaffold output ([#914](https://github.com/Studio-Saelix/sencho/issues/914)) ([73b5ca7](https://github.com/Studio-Saelix/sencho/commit/73b5ca7b34bbb3900792dbf825f2ef6357d388c0))

## [0.69.2](https://github.com/Studio-Saelix/sencho/compare/v0.69.1...v0.69.2) (2026-05-04)


### Fixed

* **backend:** batch-insert stress test metrics to avoid per-insert fsync timeout ([#911](https://github.com/Studio-Saelix/sencho/issues/911)) ([2e8ca76](https://github.com/Studio-Saelix/sencho/commit/2e8ca761038d8787d16b9670a327b668f436fc8b))

## [0.69.1](https://github.com/Studio-Saelix/sencho/compare/v0.69.0...v0.69.1) (2026-05-04)


### Fixed

* **frontend:** remove unused MockWS constructor param ([#904](https://github.com/Studio-Saelix/sencho/issues/904)) ([34fcb25](https://github.com/Studio-Saelix/sencho/commit/34fcb2591f94d8d94f25e143e0e18559d9a9df02))

## [0.69.0](https://github.com/Studio-Saelix/sencho/compare/v0.68.0...v0.69.0) (2026-05-03)


### Added

* **license:** simplify community license page to activate form + pricing link ([#892](https://github.com/Studio-Saelix/sencho/issues/892)) ([c06f937](https://github.com/Studio-Saelix/sencho/commit/c06f937d8d0452ea93c726cb718ce628aaa3013a))
* **ui:** add ConfirmModal, migrate EditorLayout inline confirms ([#897](https://github.com/Studio-Saelix/sencho/issues/897)) ([d492594](https://github.com/Studio-Saelix/sencho/commit/d492594189640c67c85c3b2d341bf03edf5c430f))
* **ui:** add Modal chrome primitives, migrate file dialogs ([#896](https://github.com/Studio-Saelix/sencho/issues/896)) ([898ef1a](https://github.com/Studio-Saelix/sencho/commit/898ef1a0e8e941d2eba722891c0f4720211898bb))
* **ui:** hide paid features from community-tier dashboard ([#891](https://github.com/Studio-Saelix/sencho/issues/891)) ([1f8ce77](https://github.com/Studio-Saelix/sencho/commit/1f8ce773ff7d42240605d4d4f8dd93c7f3c59760))


### Fixed

* **ci:** disable CLA Assistant PR auto-lock so release-please can comment ([#890](https://github.com/Studio-Saelix/sencho/issues/890)) ([b9ada7f](https://github.com/Studio-Saelix/sencho/commit/b9ada7f50bea3f2f74c8dfeb582a86fbe29d9f4c))

## [0.68.0](https://github.com/Studio-Saelix/sencho/compare/v0.67.1...v0.68.0) (2026-05-02)


### Added

* **meta:** gate deferred Fleet tabs behind SENCHO_EXPERIMENTAL flag ([#886](https://github.com/Studio-Saelix/sencho/issues/886)) ([d69fb9f](https://github.com/Studio-Saelix/sencho/commit/d69fb9f1da24ef257d58ce9682fad308be2f86ff))

## [0.67.1](https://github.com/Studio-Saelix/sencho/compare/v0.67.0...v0.67.1) (2026-05-02)


### Fixed

* **ci:** tolerate empty inline blogPosts array in scaffold script ([#883](https://github.com/Studio-Saelix/sencho/issues/883)) ([87abfc2](https://github.com/Studio-Saelix/sencho/commit/87abfc2ec0a2165aa86d00bcde286660533e99e9))

## [0.67.0](https://github.com/Studio-Saelix/sencho/compare/v0.66.2...v0.67.0) (2026-05-02)


### Added

* **entitlements:** wire dynamic import of @studio-saelix/sencho-pro ([#880](https://github.com/Studio-Saelix/sencho/issues/880)) ([cffb481](https://github.com/Studio-Saelix/sencho/commit/cffb481106702b03415445ad35b17ec159ed772a))
* **frontend:** add LazyBoundary for chunk-load failure recovery ([#875](https://github.com/Studio-Saelix/sencho/issues/875)) ([b843b89](https://github.com/Studio-Saelix/sencho/commit/b843b89ca46cef2aa93bdd3e4ec2a5f9e5e16f3f))
* **frontend:** code-split non-settings paid views and security overlay ([#872](https://github.com/Studio-Saelix/sencho/issues/872)) ([a8d1a9d](https://github.com/Studio-Saelix/sencho/commit/a8d1a9d4619a00ed1c731f90f8dcefbc7212c8f4))
* **frontend:** code-split paid-tier settings sections ([#870](https://github.com/Studio-Saelix/sencho/issues/870)) ([fd05b5e](https://github.com/Studio-Saelix/sencho/commit/fd05b5ef4b3da454540946c2920de4d769920ad3))


### Fixed

* **frontend:** replace post-dismissal blur in PaidGate / AdmiralGate with click-to-restore pill ([#874](https://github.com/Studio-Saelix/sencho/issues/874)) ([6fa0272](https://github.com/Studio-Saelix/sencho/commit/6fa0272e7999759775ba7b68a8049fd2fc62c85e))
* **frontend:** short-circuit CapabilityGate and extract shared LockCard ([#873](https://github.com/Studio-Saelix/sencho/issues/873)) ([6b74767](https://github.com/Studio-Saelix/sencho/commit/6b74767388f5d4f2737ee866f4651933f6381d87))

## [0.66.2](https://github.com/Studio-Saelix/sencho/compare/v0.66.1...v0.66.2) (2026-05-02)


### Fixed

* **license:** reject activation when LS response is missing instance.id ([#867](https://github.com/Studio-Saelix/sencho/issues/867)) ([d17562a](https://github.com/Studio-Saelix/sencho/commit/d17562ac6029c90a39a46eab72e9f5f1c1aa4c43))

## [0.66.1](https://github.com/Studio-Saelix/sencho/compare/v0.66.0...v0.66.1) (2026-05-02)


### Fixed

* **license:** verify LS store, product, and variant IDs in validate response ([#862](https://github.com/Studio-Saelix/sencho/issues/862)) ([9f9e1bd](https://github.com/Studio-Saelix/sencho/commit/9f9e1bdff0692f806c69f4831ead1aecada0cd69))

## [0.66.0](https://github.com/Studio-Saelix/sencho/compare/v0.65.1...v0.66.0) (2026-05-01)


### Added

* **blueprints:** add Fleet &gt; Deployments tab UI, node labels, and docs ([#861](https://github.com/Studio-Saelix/sencho/issues/861)) ([e5391e6](https://github.com/Studio-Saelix/sencho/commit/e5391e66cbd90027b39ab38111e6ba6b2793afdc))
* **blueprints:** backend foundation for fleet-wide compose templates ([#860](https://github.com/Studio-Saelix/sencho/issues/860)) ([685d5d7](https://github.com/Studio-Saelix/sencho/commit/685d5d729e71e6320aa015c88609b3cbda5a1f9b))
* **editor:** opt-in diff preview before save ([#855](https://github.com/Studio-Saelix/sencho/issues/855)) ([a25acbe](https://github.com/Studio-Saelix/sencho/commit/a25acbec7c1d9f933f8ebe78326f10efe79bf742))
* **fleet:** §16 orchestrator tab foundation (Deployments, Federation, Secrets) ([#856](https://github.com/Studio-Saelix/sencho/issues/856)) ([b8437e8](https://github.com/Studio-Saelix/sencho/commit/b8437e8780d6e7eeb8f9f2a9a0570e71abb700c6))
* **fleet:** sencho mesh in traffic and routing tab ([#858](https://github.com/Studio-Saelix/sencho/issues/858)) ([7663f4c](https://github.com/Studio-Saelix/sencho/commit/7663f4cd8bb3f0cba89dd994098ce0431a89b0e4))
* **pilot:** add tcp tunnel frames + mesh sidecar package ([#857](https://github.com/Studio-Saelix/sencho/issues/857)) ([6893ece](https://github.com/Studio-Saelix/sencho/commit/6893ece898f00fbacff1dd98357cb1dab7394269))
* **settings:** dress the page to match the audit ([#849](https://github.com/Studio-Saelix/sencho/issues/849)) ([eead195](https://github.com/Studio-Saelix/sencho/commit/eead1955298249e22b9444f5f1eeaeac9e0db28d))
* **sidebar:** §14 sidebar orchestration, filter chips, pinned rail, trailing column ([#850](https://github.com/Studio-Saelix/sencho/issues/850)) ([4c0efcb](https://github.com/Studio-Saelix/sencho/commit/4c0efcb9a8ffa634b376030b883af89abfd440b4))
* **sidebar:** bulk stack operations ([#854](https://github.com/Studio-Saelix/sencho/issues/854)) ([a0bf5b5](https://github.com/Studio-Saelix/sencho/commit/a0bf5b5bf5a58025db33ac54171107cad5e4d2d6))
* **stack:** per-stack activity timeline with actor attribution ([#852](https://github.com/Studio-Saelix/sencho/issues/852)) ([3e01daf](https://github.com/Studio-Saelix/sencho/commit/3e01daf76fbcfc0775555e30e99d8151959119de))

## [0.65.1](https://github.com/AnsoCode/Sencho/compare/v0.65.0...v0.65.1) (2026-04-29)


### Fixed

* **backend:** resolve ts-node dynamic import and TS2322 narrowing errors ([#839](https://github.com/AnsoCode/Sencho/issues/839)) ([7d4390a](https://github.com/AnsoCode/Sencho/commit/7d4390a7e49c3fc7631f8a32162c5d5b02cb7b43))
* **cla:** ensure signatures file has no BOM ([1f21526](https://github.com/AnsoCode/Sencho/commit/1f21526367d74d9968f0016de531c3f97f763dc5))
* **cla:** strictly enforce no-BOM UTF8 for signatures ([1a67c6c](https://github.com/AnsoCode/Sencho/commit/1a67c6c35b2c2f2d3900390dcc08235f697605a9))
* **convert:** resolve TS7016 and TS2322 for composerize dynamic import ([#837](https://github.com/AnsoCode/Sencho/issues/837)) ([219dee7](https://github.com/AnsoCode/Sencho/commit/219dee720e1f4b6435666fe710acf702621f2784))
* **docker:** upgrade CLI to v29.4.1 and Compose to v5.1.3, clear VEX ([#836](https://github.com/AnsoCode/Sencho/issues/836)) ([e124874](https://github.com/AnsoCode/Sencho/commit/e124874dac9b2c97ad0647be63d7f50316e6fb41))

## [0.65.0](https://github.com/AnsoCode/Sencho/compare/v0.64.2...v0.65.0) (2026-04-28)


### Added

* **scaffold:** fully automate release blog post publishing ([#810](https://github.com/AnsoCode/Sencho/issues/810)) ([b5acfd8](https://github.com/AnsoCode/Sencho/commit/b5acfd8f58008164c3af1f7253f8cb61347c99c3))


### Fixed

* **backend:** batch audit_log inserts into a buffered transaction ([#817](https://github.com/AnsoCode/Sencho/issues/817)) ([5cf4323](https://github.com/AnsoCode/Sencho/commit/5cf4323511eb7e1bf3640f5ceac557cb64395e5d))
* **backend:** cache global_settings reads in DatabaseService ([#814](https://github.com/AnsoCode/Sencho/issues/814)) ([836e384](https://github.com/AnsoCode/Sencho/commit/836e384d17d8e9daf7d16f900a6ed0a560c654e0))
* **backend:** lazy-load @aws-sdk/client-s3 in CloudBackupService ([#820](https://github.com/AnsoCode/Sencho/issues/820)) ([14c25a6](https://github.com/AnsoCode/Sencho/commit/14c25a6dbc908cb8de9e89199ddc3907377bf006))
* **backend:** lazy-load composerize and isomorphic-git ([#819](https://github.com/AnsoCode/Sencho/issues/819)) ([329b4ec](https://github.com/AnsoCode/Sencho/commit/329b4ec4e2f84e590f027511877ec9b5ed3d0ca7))
* **backend:** mark AWS SDK clients as optional dependencies ([#821](https://github.com/AnsoCode/Sencho/issues/821)) ([04f35fd](https://github.com/AnsoCode/Sencho/commit/04f35fdf220c8e9024875750846aed96bf4c7b09))
* **backend:** parallelize independent startup initializers ([#816](https://github.com/AnsoCode/Sencho/issues/816)) ([18cf2e6](https://github.com/AnsoCode/Sencho/commit/18cf2e65e8c4b173b1d614f52153e905b8a87ff4))
* **backend:** parallelize pruneManagedOnly removals ([#830](https://github.com/AnsoCode/Sencho/issues/830)) ([46fae21](https://github.com/AnsoCode/Sencho/commit/46fae21e67a4f0650849c45b972efbe4c84e864a))
* **backend:** replace docker system df shell-out with dockerode API ([#818](https://github.com/AnsoCode/Sencho/issues/818)) ([279ec62](https://github.com/AnsoCode/Sencho/commit/279ec62dff70cce1054df99f18160eb73d41aaac))
* **build:** enable incremental tsc ([#827](https://github.com/AnsoCode/Sencho/issues/827)) ([f4338c9](https://github.com/AnsoCode/Sencho/commit/f4338c9d6bffd8673962e8896874c69bf078762a))
* **docker:** switch builder stages to npm ci ([#822](https://github.com/AnsoCode/Sencho/issues/822)) ([eb1d627](https://github.com/AnsoCode/Sencho/commit/eb1d627096053fa3acac0576b9f66ba7d6017493))
* **fleet:** forward main node tier to remote config fetch and hide local-only fields ([#811](https://github.com/AnsoCode/Sencho/issues/811)) ([ae8211c](https://github.com/AnsoCode/Sencho/commit/ae8211c0b415ef4ac4f4968d5867e6034a8c94cb))
* **frontend:** lazy-load Monaco editor + diff editor ([#824](https://github.com/AnsoCode/Sencho/issues/824)) ([b5d038f](https://github.com/AnsoCode/Sencho/commit/b5d038f395d4909ecd1a35ad7feca65262f3fb97))
* **frontend:** lazy-load xterm chunk + addons ([#825](https://github.com/AnsoCode/Sencho/issues/825)) ([e74b4db](https://github.com/AnsoCode/Sencho/commit/e74b4db44dd327b263886440c2a54a243e2d28e8))
* **frontend:** parallelize auth bootstrap fetches ([#826](https://github.com/AnsoCode/Sencho/issues/826)) ([405f9cd](https://github.com/AnsoCode/Sencho/commit/405f9cd921f0c4868a4e2c4e774f2a598002b001))
* **frontend:** split heavyweight vendors into manual chunks ([#823](https://github.com/AnsoCode/Sencho/issues/823)) ([f5dd8af](https://github.com/AnsoCode/Sencho/commit/f5dd8af7db0f0a4d599c4f8d10c649ea96530f3e))
* **proxy:** cache LicenseService tier headers for the proxy hot path ([#815](https://github.com/AnsoCode/Sencho/issues/815)) ([61a7e43](https://github.com/AnsoCode/Sencho/commit/61a7e43d82ae181e4a506e031db60788d5971ffe))
* **test:** build baseline DB once via vitest globalSetup ([#829](https://github.com/AnsoCode/Sencho/issues/829)) ([2000653](https://github.com/AnsoCode/Sencho/commit/2000653fb4c8062063503f77815b9ad5f0804ac4))
* **test:** cap vitest fork pool at 4 workers ([#828](https://github.com/AnsoCode/Sencho/issues/828)) ([65f43b8](https://github.com/AnsoCode/Sencho/commit/65f43b803281f0743d424f2c3e0ac11df1930fbc))

## [0.64.2](https://github.com/AnsoCode/Sencho/compare/v0.64.1...v0.64.2) (2026-04-27)


### Fixed

* **backend:** use URL parser for registry scheme + template host check ([#808](https://github.com/AnsoCode/Sencho/issues/808)) ([6ac02c7](https://github.com/AnsoCode/Sencho/commit/6ac02c792a6a768091d402e6d7ceb54e208f394e))
* **deps:** bump dompurify to 3.4.0 to resolve four advisories ([#801](https://github.com/AnsoCode/Sencho/issues/801)) ([c18d369](https://github.com/AnsoCode/Sencho/commit/c18d3696e9a4f8185ccb6527a4809b0fec9160e2))

## [0.64.1](https://github.com/AnsoCode/Sencho/compare/v0.64.0...v0.64.1) (2026-04-27)


### Fixed

* **docker:** build compose plugin from ./cmd, not ./cmd/compose ([#803](https://github.com/AnsoCode/Sencho/issues/803)) ([06d9ef5](https://github.com/AnsoCode/Sencho/commit/06d9ef5904d5d75be5a7c698c0ccc8abeb477518))

## [0.64.0](https://github.com/AnsoCode/Sencho/compare/v0.63.0...v0.64.0) (2026-04-27)


### Added

* **app-store:** sort grid by stars and rotate featured weekly ([#787](https://github.com/AnsoCode/Sencho/issues/787)) ([dcf8794](https://github.com/AnsoCode/Sencho/commit/dcf8794047b1eb72d9e8c767c969d26a4168b945))
* **auto-update:** per-stack auto-update enable/disable toggle ([#771](https://github.com/AnsoCode/Sencho/issues/771)) ([af9cb0a](https://github.com/AnsoCode/Sencho/commit/af9cb0aa63f73f54fc516869a167771a1712bd9b))
* **auto-update:** show pending image updates fleet-wide on the Auto-Updates page ([#770](https://github.com/AnsoCode/Sencho/issues/770)) ([58df1a5](https://github.com/AnsoCode/Sencho/commit/58df1a50b399defd5f155d53b7d4470dfcf06031))
* change default listen port from 3000 to 1852 ([#756](https://github.com/AnsoCode/Sencho/issues/756)) ([ed553f1](https://github.com/AnsoCode/Sencho/commit/ed553f1f19fd8a7abc930fd52e2f65ea86b323fd))
* **cloud-backup:** mirror fleet snapshots to S3-compatible storage ([#782](https://github.com/AnsoCode/Sencho/issues/782)) ([03f91cd](https://github.com/AnsoCode/Sencho/commit/03f91cd5bbbf76394efb432ed177ddfc5ab554b4))
* **dashboard:** replace 24h charts with Configuration Status and Recent Activity ([#785](https://github.com/AnsoCode/Sencho/issues/785)) ([d7d8f9b](https://github.com/AnsoCode/Sencho/commit/d7d8f9bfe87ade1b19e7a0905275f873b6f1ac28))
* **deploy-logs:** opt-in deploy progress modal with structured log rows ([#779](https://github.com/AnsoCode/Sencho/issues/779)) ([dd9d338](https://github.com/AnsoCode/Sencho/commit/dd9d33813b32188027f05b7439f867ca9dd08778))
* **events:** broadcast state-invalidate on docker events so dashboard updates live ([#768](https://github.com/AnsoCode/Sencho/issues/768)) ([5c50218](https://github.com/AnsoCode/Sencho/commit/5c5021846a274c4e975ff1872e3e2a4bc445b0f6))
* **files:** per-stack file explorer ([#780](https://github.com/AnsoCode/Sencho/issues/780)) ([801a098](https://github.com/AnsoCode/Sencho/commit/801a098a5b550dbc8089117b288a0834fcfe6e95))
* **license:** replace local auto-trial with Lemon Squeezy hosted trial flow ([#755](https://github.com/AnsoCode/Sencho/issues/755)) ([d6b744e](https://github.com/AnsoCode/Sencho/commit/d6b744e8e6a55d85478b2b47f750c5098f68c59c))
* **notifications:** add structured category enum to dispatcher and history ([#774](https://github.com/AnsoCode/Sencho/issues/774)) ([44dba59](https://github.com/AnsoCode/Sencho/commit/44dba59cabc001a007d40bf5ce143f091523a6db))
* **notifications:** match routing rules by labels and categories ([#776](https://github.com/AnsoCode/Sencho/issues/776)) ([e003413](https://github.com/AnsoCode/Sencho/commit/e0034132b4251b9adc13059b3af9f90b243e3bf7))
* **scheduler:** add auto_backup, auto_stop, auto_down, auto_start and delete_after_run one-shot mode ([#777](https://github.com/AnsoCode/Sencho/issues/777)) ([abee078](https://github.com/AnsoCode/Sencho/commit/abee078741333b873abf6042f1147bcb62f49444))
* **scheduler:** support fleet-wide auto-update schedules per node ([#773](https://github.com/AnsoCode/Sencho/issues/773)) ([a74564f](https://github.com/AnsoCode/Sencho/commit/a74564fd61df0236a387d9ed67fd1180cb878dd5))
* **security:** add SBOM attestations, VEX document, and retire .trivyignore ([#790](https://github.com/AnsoCode/Sencho/issues/790)) ([3668c71](https://github.com/AnsoCode/Sencho/commit/3668c71860e49a6acb45237b7b358a32ab7e9cf5))
* **security:** rebuild Docker CLI/Compose from source, pin base image digests ([#789](https://github.com/AnsoCode/Sencho/issues/789)) ([7e4ea71](https://github.com/AnsoCode/Sencho/commit/7e4ea714c1d72dd4e63a345f2a7d73025859f1dd))
* **sidebar:** keyboard shortcuts for stack menu actions ([#729](https://github.com/AnsoCode/Sencho/issues/729)) ([1ef9658](https://github.com/AnsoCode/Sencho/commit/1ef96582e10264f0113615650a95d9d2fba6ac3e))
* **sso:** split SSO providers by delivery model across tiers ([#754](https://github.com/AnsoCode/Sencho/issues/754)) ([a502da5](https://github.com/AnsoCode/Sencho/commit/a502da54ee2d6befdbe414d54b8d8182f42cdde8))
* **stacks:** add optional volume prune to delete confirmation ([#788](https://github.com/AnsoCode/Sencho/issues/788)) ([38a9f27](https://github.com/AnsoCode/Sencho/commit/38a9f277c679cd58b26076403a923734cfa31542))
* **stacks:** add Schedule task shortcut to stack context and kebab menus ([#772](https://github.com/AnsoCode/Sencho/issues/772)) ([819d2a6](https://github.com/AnsoCode/Sencho/commit/819d2a63fcfd124609e3041f5dbae186660dd8dd))
* **stacks:** per-service start/stop/restart lifecycle actions ([#778](https://github.com/AnsoCode/Sencho/issues/778)) ([6986b92](https://github.com/AnsoCode/Sencho/commit/6986b927e301bacc78aeffa55bd250dec9647df0))


### Fixed

* **auto-update:** label same-tag rebuilds as 'Rebuild available' instead of '10.11 -&gt; 10.11' ([#766](https://github.com/AnsoCode/Sencho/issues/766)) ([584cda7](https://github.com/AnsoCode/Sencho/commit/584cda718238f379c014f686edd27b32069e52db))
* **backend:** restore remote proxy mount order before local routers ([#747](https://github.com/AnsoCode/Sencho/issues/747)) ([43a5959](https://github.com/AnsoCode/Sencho/commit/43a595905b1474908d96260f70a49dbf16812e32))
* **env:** return empty body for missing .env files; surface non-OK responses cleanly ([#767](https://github.com/AnsoCode/Sencho/issues/767)) ([a962654](https://github.com/AnsoCode/Sencho/commit/a962654a3b96e9822df2aca387d8c9e525d39e1c))
* **frontend:** clear sidebar update dot after toolbar Update click ([#763](https://github.com/AnsoCode/Sencho/issues/763)) ([5746104](https://github.com/AnsoCode/Sencho/commit/57461043b06f3c5f4f86312a93ffc7086c4db8ac))
* **frontend:** make copy buttons work over plain HTTP ([#757](https://github.com/AnsoCode/Sencho/issues/757)) ([4c35226](https://github.com/AnsoCode/Sencho/commit/4c352267198f94e69a3fab85228a5484c0f7363e))
* **frontend:** stream log lines on next paint and show ms-precision timestamps ([#764](https://github.com/AnsoCode/Sencho/issues/764)) ([c9657b1](https://github.com/AnsoCode/Sencho/commit/c9657b1d46746b43310c3045a06f58a773d73099))
* **login:** remove branding duplication, add shimmer and ping dot ([#727](https://github.com/AnsoCode/Sencho/issues/727)) ([d47f6b4](https://github.com/AnsoCode/Sencho/commit/d47f6b40e4b2f01fac3b9151318b1ada3e74d6fc))
* **logs:** drop millisecond suffix from log timestamp display ([#769](https://github.com/AnsoCode/Sencho/issues/769)) ([c7cdcd0](https://github.com/AnsoCode/Sencho/commit/c7cdcd082d64281dcfe2b031b699c2fd3e83bdb6))
* **monitor:** include node name in janitor alert and stop firing on near-empty hosts ([#765](https://github.com/AnsoCode/Sencho/issues/765)) ([9e0f521](https://github.com/AnsoCode/Sencho/commit/9e0f521ea8fb8809367de1fa646dc263e8d93fd9))
* **notifications:** scope routing rules to nodes via node_id column ([#775](https://github.com/AnsoCode/Sencho/issues/775)) ([fcbdd59](https://github.com/AnsoCode/Sencho/commit/fcbdd59ec24d9bac180a19310eee29334d6eadb6))
* **security:** clear cached policy evaluations when a scan policy is deleted ([#758](https://github.com/AnsoCode/Sencho/issues/758)) ([24c0a28](https://github.com/AnsoCode/Sencho/commit/24c0a2833ba527bcb56e2b8dce682194f182a8f2))
* **sidebar:** remove 1-hour staleness filter from activity ticker ([#786](https://github.com/AnsoCode/Sencho/issues/786)) ([f94b2ce](https://github.com/AnsoCode/Sencho/commit/f94b2ce85cddd6774c1dd7be83c6bbbe89d0697b))

## [0.63.0](https://github.com/AnsoCode/Sencho/compare/v0.62.0...v0.63.0) (2026-04-21)


### Added

* **auth:** redesign login, MFA, and setup surfaces with cockpit voice ([#714](https://github.com/AnsoCode/Sencho/issues/714)) ([0a01980](https://github.com/AnsoCode/Sencho/commit/0a0198013d714d2e06acaef4414cc03a29062065))
* **design-system:** retune oklch tokens to cozy-pebble palette ([#709](https://github.com/AnsoCode/Sencho/issues/709)) ([2b499cb](https://github.com/AnsoCode/Sencho/commit/2b499cb2c95fab0a348b18f1d973c3dd2d4c3d8c))
* **fleet:** aggregate labels across nodes and allow remote edits ([#710](https://github.com/AnsoCode/Sencho/issues/710)) ([a41af47](https://github.com/AnsoCode/Sencho/commit/a41af47ff3506afd4fa51b11e390308fd41daf44))
* **fleet:** interactive topology with ReactFlow hub-and-spoke layout ([#713](https://github.com/AnsoCode/Sencho/issues/713)) ([d95e154](https://github.com/AnsoCode/Sencho/commit/d95e154aeb57310d3486d540c9b3087c10afafe6))
* **fleet:** reorganize overview page for clarity and density ([#712](https://github.com/AnsoCode/Sencho/issues/712)) ([6f132b7](https://github.com/AnsoCode/Sencho/commit/6f132b7ffe93132d9c296f53ebdaf5084706341a))
* **notifications:** add per-node filter and 60s refetch safety net ([#717](https://github.com/AnsoCode/Sencho/issues/717)) ([3e1fb76](https://github.com/AnsoCode/Sencho/commit/3e1fb76bd0c7b8bce66a556618bbae96473af82f))
* **search:** add global Ctrl+K command palette ([#711](https://github.com/AnsoCode/Sencho/issues/711)) ([856de35](https://github.com/AnsoCode/Sencho/commit/856de35a52a4e17c18b337a296112d529b1a9406))
* **security:** enforce scan policies as a pre-deploy gate ([#719](https://github.com/AnsoCode/Sencho/issues/719)) ([661b9c6](https://github.com/AnsoCode/Sencho/commit/661b9c638b7b7dc4e11d86d36edaf2cab6e1bf75))
* **security:** polish scan sheets, fix CVE links, surface policy violations ([#721](https://github.com/AnsoCode/Sencho/issues/721)) ([12c2b37](https://github.com/AnsoCode/Sencho/commit/12c2b37510b5f364ee42f582edcbb8fb655c269b))
* **settings:** surface security, notifications, and app store on remote nodes ([#716](https://github.com/AnsoCode/Sencho/issues/716)) ([08f57c7](https://github.com/AnsoCode/Sencho/commit/08f57c714146d4fe533b82e1011a18d86cd957a1))
* **sidebar:** cockpit redesign with grouped stacks and activity footer ([#702](https://github.com/AnsoCode/Sencho/issues/702)) ([370b67d](https://github.com/AnsoCode/Sencho/commit/370b67d7ec5f8f5ee1d8df81bdd4a892c0c0c9d5))
* **sidebar:** inline label create, live sync, and kebab submenu parity ([#706](https://github.com/AnsoCode/Sencho/issues/706)) ([75370d8](https://github.com/AnsoCode/Sencho/commit/75370d8fce8c0d9669f957a54db8e6e145ce5804))
* **ui:** redesign global logs as cockpit surface ([#699](https://github.com/AnsoCode/Sencho/issues/699)) ([b95442c](https://github.com/AnsoCode/Sencho/commit/b95442c8f7c0a69b53893382f9cafdbbea44efcf))
* **ui:** redesign host console as cockpit surface ([#701](https://github.com/AnsoCode/Sencho/issues/701)) ([490c89c](https://github.com/AnsoCode/Sencho/commit/490c89c049f7d379ef8a72e36970638807163683))


### Fixed

* **app-store:** use stack name as compose service key ([#704](https://github.com/AnsoCode/Sencho/issues/704)) ([9f861e0](https://github.com/AnsoCode/Sencho/commit/9f861e00721a71c615a6478b24aec2b8087b2fc7))
* **dashboard:** remove peak indicator dot from CPU sparkline ([#705](https://github.com/AnsoCode/Sencho/issues/705)) ([5f2d678](https://github.com/AnsoCode/Sencho/commit/5f2d67848cda077edbde349ce07ed261ff743e3d))
* **security:** convert scan history from full page to sheet overlay ([#720](https://github.com/AnsoCode/Sencho/issues/720)) ([e4fdb1c](https://github.com/AnsoCode/Sencho/commit/e4fdb1cd6c32016a646bf23d3e4ae3d5fafe4e02))
* **sidebar:** distinct fuchsia notification dot for update indicator ([#708](https://github.com/AnsoCode/Sencho/issues/708)) ([c7dfde4](https://github.com/AnsoCode/Sencho/commit/c7dfde4b79eb5110d7d5420002a0631151401645))
* **trivy:** remove unsupported --no-progress flag from `trivy config` ([#718](https://github.com/AnsoCode/Sencho/issues/718)) ([aa10db1](https://github.com/AnsoCode/Sencho/commit/aa10db1d09261741faf5b2f8cd6a64436facf2f6))
* **ui:** raise toast z-index above dialog overlays ([#715](https://github.com/AnsoCode/Sencho/issues/715)) ([a42cc5b](https://github.com/AnsoCode/Sencho/commit/a42cc5bf03a971ebb21fc516363a11b362053793))

## [0.62.0](https://github.com/AnsoCode/Sencho/compare/v0.61.0...v0.62.0) (2026-04-19)


### Added

* **notifications:** deep-link bell rows to source stack and container logs ([#692](https://github.com/AnsoCode/Sencho/issues/692)) ([ed2a16a](https://github.com/AnsoCode/Sencho/commit/ed2a16af798db3db80cce89b550c1c27f418753d))
* **sidebar:** global multi-node stack search with status ([#685](https://github.com/AnsoCode/Sencho/issues/685)) ([bd94ef9](https://github.com/AnsoCode/Sencho/commit/bd94ef9e1549eea85a1e6f0e0389eb7ac5d6db4d))
* **stack-view:** anatomy panel replaces always-open yaml ([#690](https://github.com/AnsoCode/Sencho/issues/690)) ([9e41d5e](https://github.com/AnsoCode/Sencho/commit/9e41d5e6b81015e04f10b7ae699d2f228a78eaf0))
* **stack-view:** identity header with health state and action hierarchy ([#688](https://github.com/AnsoCode/Sencho/issues/688)) ([82aabfe](https://github.com/AnsoCode/Sencho/commit/82aabfe64caa43548757f0f13fcaadde1b5a0518))
* **stack-view:** per-container health strip and structured logs viewer ([#689](https://github.com/AnsoCode/Sencho/issues/689)) ([a65a1c0](https://github.com/AnsoCode/Sencho/commit/a65a1c0e867ad8d52cdbbe972548a040deea0ae2))
* **ui:** redesign node switcher as sidebar identity anchor ([#694](https://github.com/AnsoCode/Sencho/issues/694)) ([e721742](https://github.com/AnsoCode/Sencho/commit/e7217425605df55911405cc51cc48fca200b6622))
* **ui:** redesign top bar as chrome-glass masthead ([#696](https://github.com/AnsoCode/Sencho/issues/696)) ([5589110](https://github.com/AnsoCode/Sencho/commit/5589110925907f6f7bfee234f3e004c0485239c2))
* **ui:** redesign user menu and notification panel ([#691](https://github.com/AnsoCode/Sencho/issues/691)) ([7c01906](https://github.com/AnsoCode/Sencho/commit/7c01906e708f1b8af56fa07e257d2ae5e3e76c76))
* **ui:** replace Switch with TogglePill per design audit ([#687](https://github.com/AnsoCode/Sencho/issues/687)) ([88ec71f](https://github.com/AnsoCode/Sencho/commit/88ec71fcaaf7caea21697505ab638c5faeacfa30))
* **ui:** wire overlay popovers to density tokens ([#695](https://github.com/AnsoCode/Sencho/issues/695)) ([72a1ecd](https://github.com/AnsoCode/Sencho/commit/72a1ecd19290e3895def4f8c6a4b5e7fbf28404e))

## [0.61.0](https://github.com/AnsoCode/Sencho/compare/v0.60.0...v0.61.0) (2026-04-18)


### Added

* **app-store:** editorial hero, category rail, security scan signal per tile ([#679](https://github.com/AnsoCode/Sencho/issues/679)) ([ec76206](https://github.com/AnsoCode/Sencho/commit/ec7620675e7fb9cf33a5ec842992bd7d537f02aa))
* **audit-log:** signal rail, day-banded stream, anomaly detection ([#682](https://github.com/AnsoCode/Sencho/issues/682)) ([591dc75](https://github.com/AnsoCode/Sencho/commit/591dc75d1ee992f28f2d3bb2dcf1fc899c0b9fa2))
* **dashboard:** status masthead, unified gauges, stack health sparklines ([#676](https://github.com/AnsoCode/Sencho/issues/676)) ([748ba46](https://github.com/AnsoCode/Sencho/commit/748ba46669aa5dcdc97a80a133da7d9f9f85be36))
* **design-system:** adopt cyan as data color, add Instrument Serif, introduce label roles ([#674](https://github.com/AnsoCode/Sencho/issues/674)) ([7ec189d](https://github.com/AnsoCode/Sencho/commit/7ec189dc3508de8a4458157425f3928b2ffa7c68))
* **fleet:** add aggregate masthead and local-vs-remote topology ([#677](https://github.com/AnsoCode/Sencho/issues/677)) ([c3b06f4](https://github.com/AnsoCode/Sencho/commit/c3b06f4b13b8c6e2c59bbb7ec8e04c27a84d861a))
* **resources:** lead with reclaimable disk banner and per-tab landings ([#678](https://github.com/AnsoCode/Sencho/issues/678)) ([5f6fdfc](https://github.com/AnsoCode/Sencho/commit/5f6fdfcba88ab103b4ad8ac0c6a0f6022e6a3d21))
* **schedules:** next-24h timeline + merge auto-update into schedules ([#681](https://github.com/AnsoCode/Sencho/issues/681)) ([9527884](https://github.com/AnsoCode/Sencho/commit/95278843cf94917886aa8a85e2dce4bb9eb5be1e))
* **settings:** add comfortable/compact density toggle ([#683](https://github.com/AnsoCode/Sencho/issues/683)) ([ad90bd9](https://github.com/AnsoCode/Sencho/commit/ad90bd9404fd5210879c4d79db18d347b4b471d4))
* **settings:** group sections, add ⌘K search, scope breadcrumb ([#680](https://github.com/AnsoCode/Sencho/issues/680)) ([0bf061a](https://github.com/AnsoCode/Sencho/commit/0bf061a7456a4bb1a82918c0d845ca29e1cb87d6))

## [0.60.0](https://github.com/AnsoCode/Sencho/compare/v0.59.0...v0.60.0) (2026-04-18)


### Added

* auto-heal policies for unhealthy containers ([#671](https://github.com/AnsoCode/Sencho/issues/671)) ([5bb4b01](https://github.com/AnsoCode/Sencho/commit/5bb4b0195370363a7ff11d27262a22c076ba9191))

## [0.59.0](https://github.com/AnsoCode/Sencho/compare/v0.58.1...v0.59.0) (2026-04-18)


### Added

* pilot agent outbound-mode for remote nodes ([#667](https://github.com/AnsoCode/Sencho/issues/667)) ([8e7a567](https://github.com/AnsoCode/Sencho/commit/8e7a567f691cbb0cc047a69c1da38ad097b8d5ee))

## [0.58.1](https://github.com/AnsoCode/Sencho/compare/v0.58.0...v0.58.1) (2026-04-17)


### Fixed

* **security:** relabel unchanged bucket for cross-image comparisons ([#662](https://github.com/AnsoCode/Sencho/issues/662)) ([e0f2e23](https://github.com/AnsoCode/Sencho/commit/e0f2e230a64e0822ba3f9c3e4ac89f6226feecfa))
* **security:** server-driven pagination for scan history ([#661](https://github.com/AnsoCode/Sencho/issues/661)) ([2fce1d3](https://github.com/AnsoCode/Sencho/commit/2fce1d3baf3965c7c94d76422815491b6fef6794))
* **security:** signal when scan comparison is truncated ([#658](https://github.com/AnsoCode/Sencho/issues/658)) ([c211f65](https://github.com/AnsoCode/Sencho/commit/c211f655c3144927e54bf7f47697c36146692bf9))

## [0.58.0](https://github.com/AnsoCode/Sencho/compare/v0.57.0...v0.58.0) (2026-04-17)


### Added

* **security:** severity-aware scheduled scan notifications ([#654](https://github.com/AnsoCode/Sencho/issues/654)) ([29ed052](https://github.com/AnsoCode/Sencho/commit/29ed0524c1c28c614c9c624fd40d6c796b16e366))

## [0.57.0](https://github.com/AnsoCode/Sencho/compare/v0.56.0...v0.57.0) (2026-04-17)


### Added

* **fleet:** replicate scan policies across managed nodes ([#649](https://github.com/AnsoCode/Sencho/issues/649)) ([708d15b](https://github.com/AnsoCode/Sencho/commit/708d15b2b351cef50585dc2a5c8697460cb01f50))
* **scheduler:** notify on scheduled scan completion ([#646](https://github.com/AnsoCode/Sencho/issues/646)) ([e660d2a](https://github.com/AnsoCode/Sencho/commit/e660d2a658a9a0775cd5e448dd2c2933491a33d3))
* **security:** export scan results as SARIF 2.1.0 ([#652](https://github.com/AnsoCode/Sencho/issues/652)) ([12bbf86](https://github.com/AnsoCode/Sencho/commit/12bbf86dc481bf0f5ba99cf144c1161c31cbee12))
* **security:** fleet-replicated CVE suppression list ([#650](https://github.com/AnsoCode/Sencho/issues/650)) ([732fc95](https://github.com/AnsoCode/Sencho/commit/732fc95415ddeddf7827ce95ee790839e6c10e46))
* **security:** scan comparison UI ([#648](https://github.com/AnsoCode/Sencho/issues/648)) ([8ee0c0c](https://github.com/AnsoCode/Sencho/commit/8ee0c0c476e1652d59ef8e4f53dd728996e36250))
* **security:** secret and misconfiguration scanning ([#651](https://github.com/AnsoCode/Sencho/issues/651)) ([a95bf1f](https://github.com/AnsoCode/Sencho/commit/a95bf1ff333e301125ef8a2b6442f0c74f30c089))

## [0.56.0](https://github.com/AnsoCode/Sencho/compare/v0.55.1...v0.56.0) (2026-04-17)


### Added

* **security:** one-click managed Trivy install ([#643](https://github.com/AnsoCode/Sencho/issues/643)) ([61bac08](https://github.com/AnsoCode/Sencho/commit/61bac080272579161fbcac31dbe8588d2cdb4e10))

## [0.55.1](https://github.com/AnsoCode/Sencho/compare/v0.55.0...v0.55.1) (2026-04-17)


### Fixed

* **security:** harden Trivy scan lifecycle, logging, and docs ([#639](https://github.com/AnsoCode/Sencho/issues/639)) ([dc8370f](https://github.com/AnsoCode/Sencho/commit/dc8370f5a4fc143fa8c60f094b51163d0bcdd25b))

## [0.55.0](https://github.com/AnsoCode/Sencho/compare/v0.54.1...v0.55.0) (2026-04-16)


### Added

* **images:** Trivy-powered vulnerability scanning ([#635](https://github.com/AnsoCode/Sencho/issues/635)) ([c9cd699](https://github.com/AnsoCode/Sencho/commit/c9cd6990d2aa898e93de256bdf6e6a0e3461b2be))

## [0.54.1](https://github.com/AnsoCode/Sencho/compare/v0.54.0...v0.54.1) (2026-04-16)


### Fixed

* **sso:** harden Custom OIDC provider and SSO configuration ([#630](https://github.com/AnsoCode/Sencho/issues/630)) ([6890224](https://github.com/AnsoCode/Sencho/commit/6890224903bfa90aff5737f8778b6587be528416))

## [0.54.0](https://github.com/AnsoCode/Sencho/compare/v0.53.0...v0.54.0) (2026-04-16)


### Added

* add Custom OIDC provider and move SSO to Community tier ([#626](https://github.com/AnsoCode/Sencho/issues/626)) ([7c6df0a](https://github.com/AnsoCode/Sencho/commit/7c6df0aa5d0d15d62b7da8692bcc7815cf1bd685))

## [0.53.0](https://github.com/AnsoCode/Sencho/compare/v0.52.0...v0.53.0) (2026-04-16)


### Added

* docker run to compose converter ([#623](https://github.com/AnsoCode/Sencho/issues/623)) ([b2f341b](https://github.com/AnsoCode/Sencho/commit/b2f341b43d5fd2da408ef25635d3f1b38c5e7d58))

## [0.52.0](https://github.com/AnsoCode/Sencho/compare/v0.51.0...v0.52.0) (2026-04-15)


### Added

* **mfa:** UX hardening — auto-submit, paste tolerance, low-codes warning, dev-mode diagnostics ([#620](https://github.com/AnsoCode/Sencho/issues/620)) ([4722028](https://github.com/AnsoCode/Sencho/commit/4722028904463dcd4019b2a9cf17a531f3b9da04))

## [0.51.0](https://github.com/AnsoCode/Sencho/compare/v0.50.0...v0.51.0) (2026-04-15)


### Added

* **auth:** add TOTP two-factor authentication with backup codes ([#615](https://github.com/AnsoCode/Sencho/issues/615)) ([7d78c9f](https://github.com/AnsoCode/Sencho/commit/7d78c9fe22a2f42941397b980a46248402741598))

## [0.50.0](https://github.com/AnsoCode/Sencho/compare/v0.49.0...v0.50.0) (2026-04-15)


### Added

* **git-sources:** harden create-from-git with LFS + submodule warnings ([#609](https://github.com/AnsoCode/Sencho/issues/609)) ([6529a24](https://github.com/AnsoCode/Sencho/commit/6529a245304438bb7120361cb05fcb9616917d32))

## [0.49.0](https://github.com/AnsoCode/Sencho/compare/v0.48.1...v0.49.0) (2026-04-15)


### Added

* **git-sources:** create a stack from a Git repository ([#606](https://github.com/AnsoCode/Sencho/issues/606)) ([3955267](https://github.com/AnsoCode/Sencho/commit/3955267bbe5eac816f8e80a9e6a41dbcefdd75b0))

## [0.48.1](https://github.com/AnsoCode/Sencho/compare/v0.48.0...v0.48.1) (2026-04-15)


### Fixed

* **git-sources:** harden validation, RBAC, concurrency, and deploy recovery ([#603](https://github.com/AnsoCode/Sencho/issues/603)) ([00901cf](https://github.com/AnsoCode/Sencho/commit/00901cf5bf0b618651e185ad796c0502a7735380))

## [0.48.0](https://github.com/AnsoCode/Sencho/compare/v0.47.0...v0.48.0) (2026-04-15)


### Added

* **git-sources:** link stacks to Git repositories with diff-and-apply workflow ([#600](https://github.com/AnsoCode/Sencho/issues/600)) ([377df7e](https://github.com/AnsoCode/Sencho/commit/377df7e54631a4f791deb1432dbec80b3844159a))

## [0.47.0](https://github.com/AnsoCode/Sencho/compare/v0.46.20...v0.47.0) (2026-04-14)


### Added

* **registries:** harden Private Registry Credentials feature ([#597](https://github.com/AnsoCode/Sencho/issues/597)) ([6275adc](https://github.com/AnsoCode/Sencho/commit/6275adc6b35eaad1322dedd537551b7519052980))

## [0.46.20](https://github.com/AnsoCode/Sencho/compare/v0.46.19...v0.46.20) (2026-04-14)


### Fixed

* **notifications:** stop Sencho version notifications from silently skipping ([#594](https://github.com/AnsoCode/Sencho/issues/594)) ([6b8c369](https://github.com/AnsoCode/Sencho/commit/6b8c369745b16fad7ba6f97026751192ccc24572))

## [0.46.19](https://github.com/AnsoCode/Sencho/compare/v0.46.18...v0.46.19) (2026-04-14)


### Fixed

* **docker-events:** harden crash detection against edge cases ([#591](https://github.com/AnsoCode/Sencho/issues/591)) ([44a89d9](https://github.com/AnsoCode/Sencho/commit/44a89d9d2e4c114859a1f54665ad08c112632c1d))

## [0.46.18](https://github.com/AnsoCode/Sencho/compare/v0.46.17...v0.46.18) (2026-04-14)


### Fixed

* **notifications:** replace polling with Docker event stream for container lifecycle detection ([#588](https://github.com/AnsoCode/Sencho/issues/588)) ([ad9a685](https://github.com/AnsoCode/Sencho/commit/ad9a6859e6f854b750aeaf1348bae5470af8f768))

## [0.46.17](https://github.com/AnsoCode/Sencho/compare/v0.46.16...v0.46.17) (2026-04-14)


### Fixed

* **notifications:** resolve version notification showing 0.0.0 and backfill missing image update notifications ([#586](https://github.com/AnsoCode/Sencho/issues/586)) ([4a03193](https://github.com/AnsoCode/Sencho/commit/4a0319331a80a63273b8299ee3cbca75c88a91ce))

## [0.46.16](https://github.com/AnsoCode/Sencho/compare/v0.46.15...v0.46.16) (2026-04-14)


### Fixed

* **network-topology:** harden with edge-case fixes, logging, and test coverage ([#583](https://github.com/AnsoCode/Sencho/issues/583)) ([23fc702](https://github.com/AnsoCode/Sencho/commit/23fc702296fd1827d3b7e916f8e0014d3509166e))

## [0.46.15](https://github.com/AnsoCode/Sencho/compare/v0.46.14...v0.46.15) (2026-04-14)


### Fixed

* **host-console:** harden with security fixes, validation, and test coverage ([#580](https://github.com/AnsoCode/Sencho/issues/580)) ([718c1eb](https://github.com/AnsoCode/Sencho/commit/718c1eb1eac4560efe623ef0350c25e304b852b1))

## [0.46.14](https://github.com/AnsoCode/Sencho/compare/v0.46.13...v0.46.14) (2026-04-14)


### Fixed

* **container-exec:** harden with security fixes, validation, and test coverage ([#577](https://github.com/AnsoCode/Sencho/issues/577)) ([c4ff583](https://github.com/AnsoCode/Sencho/commit/c4ff58347e45c52b0a296aea72de3cfdefd09d6d))

## [0.46.13](https://github.com/AnsoCode/Sencho/compare/v0.46.12...v0.46.13) (2026-04-14)


### Fixed

* **notification-routing:** harden with security fixes, validation, and test coverage ([#573](https://github.com/AnsoCode/Sencho/issues/573)) ([e59df35](https://github.com/AnsoCode/Sencho/commit/e59df354e227572aec75f428a40c386e96268711))

## [0.46.12](https://github.com/AnsoCode/Sencho/compare/v0.46.11...v0.46.12) (2026-04-14)


### Fixed

* **alerts:** harden with security fixes, design compliance, and test coverage ([#570](https://github.com/AnsoCode/Sencho/issues/570)) ([0a94df3](https://github.com/AnsoCode/Sencho/commit/0a94df318ae0e5bc55c646927f568501b36c5287))

## [0.46.11](https://github.com/AnsoCode/Sencho/compare/v0.46.10...v0.46.11) (2026-04-13)


### Fixed

* **api-tokens:** harden with security fixes, design compliance, and test coverage ([#567](https://github.com/AnsoCode/Sencho/issues/567)) ([e0d1ca9](https://github.com/AnsoCode/Sencho/commit/e0d1ca9dc00fb2b30ce5e8e7f6181c38cd9b1289))

## [0.46.10](https://github.com/AnsoCode/Sencho/compare/v0.46.9...v0.46.10) (2026-04-13)


### Fixed

* **sso:** harden SSO with role sync, security fixes, design compliance, and test coverage ([#564](https://github.com/AnsoCode/Sencho/issues/564)) ([1d89e8c](https://github.com/AnsoCode/Sencho/commit/1d89e8ce59cba102ae92741ed639461338b21620))

## [0.46.9](https://github.com/AnsoCode/Sencho/compare/v0.46.8...v0.46.9) (2026-04-13)


### Fixed

* **audit:** harden audit log with summary fixes, design compliance, and test coverage ([#561](https://github.com/AnsoCode/Sencho/issues/561)) ([6daa7a1](https://github.com/AnsoCode/Sencho/commit/6daa7a135dca665484ae85f5c020b8c3c050e835))

## [0.46.8](https://github.com/AnsoCode/Sencho/compare/v0.46.7...v0.46.8) (2026-04-13)


### Fixed

* **rbac:** harden user management with token versioning, session invalidation, and test coverage ([#558](https://github.com/AnsoCode/Sencho/issues/558)) ([c261fbc](https://github.com/AnsoCode/Sencho/commit/c261fbc327ca92169bdd439c297cd96e5e6751de))

## [0.46.7](https://github.com/AnsoCode/Sencho/compare/v0.46.6...v0.46.7) (2026-04-13)


### Fixed

* **fleet:** harden fleet snapshots with DRY capture, audit fixes, and design compliance ([#555](https://github.com/AnsoCode/Sencho/issues/555)) ([809bf76](https://github.com/AnsoCode/Sencho/commit/809bf76c205e9a4e0f20db735c55b010b98851eb))

## [0.46.6](https://github.com/AnsoCode/Sencho/compare/v0.46.5...v0.46.6) (2026-04-13)


### Fixed

* **labels:** harden stack labels with nodeId filtering, concurrency guard, and test coverage ([#552](https://github.com/AnsoCode/Sencho/issues/552)) ([a695251](https://github.com/AnsoCode/Sencho/commit/a695251f38a21dd12ba535471a9e934928d5672e))

## [0.46.5](https://github.com/AnsoCode/Sencho/compare/v0.46.4...v0.46.5) (2026-04-13)


### Fixed

* **scheduler:** harden scheduled operations with stale cleanup, cron validation, and design fixes ([#549](https://github.com/AnsoCode/Sencho/issues/549)) ([44e8fdf](https://github.com/AnsoCode/Sencho/commit/44e8fdfba9455231f1ac3469bbd58745eb33bb10))

## [0.46.4](https://github.com/AnsoCode/Sencho/compare/v0.46.3...v0.46.4) (2026-04-13)


### Fixed

* **scheduler:** harden auto-update policies with cascade deletes, error reporting, and UI fixes ([#545](https://github.com/AnsoCode/Sencho/issues/545)) ([a17b16b](https://github.com/AnsoCode/Sencho/commit/a17b16b2586206556453174e8712922eeb48cc41))

## [0.46.3](https://github.com/AnsoCode/Sencho/compare/v0.46.2...v0.46.3) (2026-04-13)


### Fixed

* **fleet:** harden remote node updates with admin enforcement, expiry fix, and diagnostics ([#542](https://github.com/AnsoCode/Sencho/issues/542)) ([d23c677](https://github.com/AnsoCode/Sencho/commit/d23c6779afd912a165ab44e79c8b7f4853d0df06))

## [0.46.2](https://github.com/AnsoCode/Sencho/compare/v0.46.1...v0.46.2) (2026-04-13)


### Fixed

* **logs:** harden global logs with shared parsing, SSE fixes, and level filter ([#539](https://github.com/AnsoCode/Sencho/issues/539)) ([a74a516](https://github.com/AnsoCode/Sencho/commit/a74a516850314ec5d17144987d3b9f87831047e2))

## [0.46.1](https://github.com/AnsoCode/Sencho/compare/v0.46.0...v0.46.1) (2026-04-13)


### Fixed

* **fleet:** add auth middleware, input validation, and design system compliance ([#536](https://github.com/AnsoCode/Sencho/issues/536)) ([1702dab](https://github.com/AnsoCode/Sencho/commit/1702dabb7af910c523970d1daa939861c047b714))

## [0.46.0](https://github.com/AnsoCode/Sencho/compare/v0.45.6...v0.46.0) (2026-04-12)


### Added

* **app-store:** add port conflict indicator to deploy sheet ([#533](https://github.com/AnsoCode/Sencho/issues/533)) ([cd3d7b2](https://github.com/AnsoCode/Sencho/commit/cd3d7b23be444a8c085255b557ef2594e9b3fea5))

## [0.45.6](https://github.com/AnsoCode/Sencho/compare/v0.45.5...v0.45.6) (2026-04-12)


### Fixed

* **app-store:** handle orphaned stack directories on template deploy ([#530](https://github.com/AnsoCode/Sencho/issues/530)) ([5f91e16](https://github.com/AnsoCode/Sencho/commit/5f91e16417f86f04bb8f5aad2fd49f008a24c057))

## [0.45.5](https://github.com/AnsoCode/Sencho/compare/v0.45.4...v0.45.5) (2026-04-12)


### Fixed

* **resources:** harden Resource Explorer with auth, validation, design, and UX fixes ([#527](https://github.com/AnsoCode/Sencho/issues/527)) ([4909c35](https://github.com/AnsoCode/Sencho/commit/4909c35e50ec0227d153f79b34ba27d159cd55ae))

## [0.45.4](https://github.com/AnsoCode/Sencho/compare/v0.45.3...v0.45.4) (2026-04-12)


### Fixed

* **app-store:** harden App Store with auth, validation, bug fixes, and design compliance ([#523](https://github.com/AnsoCode/Sencho/issues/523)) ([d4882d3](https://github.com/AnsoCode/Sencho/commit/d4882d32d90e7635df51f5e79b89717594928496))

## [0.45.3](https://github.com/AnsoCode/Sencho/compare/v0.45.2...v0.45.3) (2026-04-12)


### Fixed

* **stacks:** harden stack management with security, validation, and logging ([#520](https://github.com/AnsoCode/Sencho/issues/520)) ([2465f76](https://github.com/AnsoCode/Sencho/commit/2465f7607e5bccd0b0f84d0ca9f1eecc18018753))

## [0.45.2](https://github.com/AnsoCode/Sencho/compare/v0.45.1...v0.45.2) (2026-04-12)


### Fixed

* **dashboard:** harden real-time dashboard with bug fixes and design compliance ([#517](https://github.com/AnsoCode/Sencho/issues/517)) ([9db9710](https://github.com/AnsoCode/Sencho/commit/9db97107aa1130c0cd6ecc064e2e522991bb6913))

## [0.45.1](https://github.com/AnsoCode/Sencho/compare/v0.45.0...v0.45.1) (2026-04-12)


### Fixed

* **updates:** scan all filesystem stacks for image updates ([#514](https://github.com/AnsoCode/Sencho/issues/514)) ([4950cd0](https://github.com/AnsoCode/Sencho/commit/4950cd0bd094ab620b79971ca33817c1c62940f3))

## [0.45.0](https://github.com/AnsoCode/Sencho/compare/v0.44.1...v0.45.0) (2026-04-12)


### Added

* add automated docs pipeline and scaffold /docs folder ([9496b14](https://github.com/AnsoCode/Sencho/commit/9496b14f723858d7134e90bf27d921791045dacf))
* add Community/Pro licensing, fleet view, and UI reorganization ([#145](https://github.com/AnsoCode/Sencho/issues/145)) ([4f26f22](https://github.com/AnsoCode/Sencho/commit/4f26f22ccef89441be032a266723cf6fca0a488a))
* add update-screenshots CI job and screenshot capture spec ([ed8b8e3](https://github.com/AnsoCode/Sencho/commit/ed8b8e33b6b52d9cefef9a2a677a9e12a1b34e61))
* **api-tokens:** add scoped API tokens for CI/CD automation (Team Pro) ([#220](https://github.com/AnsoCode/Sencho/issues/220)) ([8d8118c](https://github.com/AnsoCode/Sencho/commit/8d8118c963a1c3b10872041ea0f645d8f0a65196))
* **api:** add global rate limiter for all API endpoints ([#317](https://github.com/AnsoCode/Sencho/issues/317)) ([b28ebfa](https://github.com/AnsoCode/Sencho/commit/b28ebfa6ffff7fa76657c67e5fdb3494a76bd8a1))
* **app-store:** category filter bar + custom registry settings ([ae4540b](https://github.com/AnsoCode/Sencho/commit/ae4540bf4613c2ae416c828b622bb4e198f1a11f))
* **app-store:** category filter bar and custom registry settings ([34cad76](https://github.com/AnsoCode/Sencho/commit/34cad76d45fe7212bd61aa514f40e13217e2fd8e))
* audit logging, secrets at rest, and legacy cleanup ([#205](https://github.com/AnsoCode/Sencho/issues/205)) ([1799030](https://github.com/AnsoCode/Sencho/commit/179903006035280d5c1655daaf3dbe3384588bf0))
* **audit-log:** add configurable retention, export, Auditor role, and enhanced filtering ([#258](https://github.com/AnsoCode/Sencho/issues/258)) ([d586ce3](https://github.com/AnsoCode/Sencho/commit/d586ce393af34c8cc34cd046d2d90a70e0d79964))
* **auth:** redesign Login and Setup pages with split-panel branding layout ([#153](https://github.com/AnsoCode/Sencho/issues/153)) ([e0319b5](https://github.com/AnsoCode/Sencho/commit/e0319b5daebbae88b942ba55f6891ce0e2ecaf29))
* **auth:** redesign Login and Setup pages with split-panel branding layout ([#168](https://github.com/AnsoCode/Sencho/issues/168)) ([f80190d](https://github.com/AnsoCode/Sencho/commit/f80190d926c1d768ee1282861dffc7d272f06e21))
* auto-refresh doc screenshots on develop push ([eaf2177](https://github.com/AnsoCode/Sencho/commit/eaf217720c42a07cce7afadd673178c886717878))
* **auto-update:** add auto-update policies and fix image update detection ([#297](https://github.com/AnsoCode/Sencho/issues/297)) ([28c7a8f](https://github.com/AnsoCode/Sencho/commit/28c7a8fd544f33ea0fbe90f19ed96154743eb527))
* automated docs pipeline ([05a6b93](https://github.com/AnsoCode/Sencho/commit/05a6b93af0b2de04e70565445178873d5f858348))
* **ci:** add release-please automated versioning workflow ([c2d5d37](https://github.com/AnsoCode/Sencho/commit/c2d5d37be41267e71bb8515010b049fcd31f5d6b))
* **ci:** add release-please automated versioning workflow ([c2d5d37](https://github.com/AnsoCode/Sencho/commit/c2d5d37be41267e71bb8515010b049fcd31f5d6b))
* **ci:** add release-please automated versioning workflow ([c294def](https://github.com/AnsoCode/Sencho/commit/c294def7ccce1705be55e38e19c7da4f7341c3f4))
* **ci:** automated versioning with release-please ([c991b81](https://github.com/AnsoCode/Sencho/commit/c991b8121edcd30bd6806e959d0dcd14711f439f))
* **ci:** automated versioning with release-please ([c991b81](https://github.com/AnsoCode/Sencho/commit/c991b8121edcd30bd6806e959d0dcd14711f439f))
* **contact:** add official contact emails throughout app and docs ([#428](https://github.com/AnsoCode/Sencho/issues/428)) ([8e0857e](https://github.com/AnsoCode/Sencho/commit/8e0857e7f62d89434768da5f57223ae25276b33d))
* **dashboard:** add node badge to Recent Alerts for remote node alerts ([#423](https://github.com/AnsoCode/Sencho/issues/423)) ([a6849ae](https://github.com/AnsoCode/Sencho/commit/a6849aedabc06cd85a74a915445765ff6f857f6f))
* **dashboard:** redesign as DevOps command center ([#371](https://github.com/AnsoCode/Sencho/issues/371)) ([2ee959e](https://github.com/AnsoCode/Sencho/commit/2ee959ec3b696c5beba7b8b62bec2221ca65d525))
* **design:** animated design system foundation with animate-ui and motion ([c34092f](https://github.com/AnsoCode/Sencho/commit/c34092f8ec07fa84e1bb83775ac767c6cb2dd744))
* **design:** animated design system foundation with animate-ui and motion ([0cb5fae](https://github.com/AnsoCode/Sencho/commit/0cb5fae947ac69b5e3b6c06c82d2f2870e6600de))
* **docker:** add linux/arm64 platform support via xx cross-compilation ([cf19390](https://github.com/AnsoCode/Sencho/commit/cf19390fd559a0ee49b9c2b08675565afd715dd5))
* **docker:** add linux/arm64 platform support via xx cross-compilation ([cf19390](https://github.com/AnsoCode/Sencho/commit/cf19390fd559a0ee49b9c2b08675565afd715dd5))
* **fleet:** add Pro fleet management features and container drill-down ([#174](https://github.com/AnsoCode/Sencho/issues/174)) ([0630f57](https://github.com/AnsoCode/Sencho/commit/0630f57ca87451352e7c50d511522ac621771458))
* **fleet:** add remote node update management ([#353](https://github.com/AnsoCode/Sencho/issues/353)) ([87b5908](https://github.com/AnsoCode/Sencho/commit/87b59082887902af24ad2bf88ae3d4d4c941411e))
* home dashboard and Settings Hub polish ([#506](https://github.com/AnsoCode/Sencho/issues/506)) ([622c1f9](https://github.com/AnsoCode/Sencho/commit/622c1f9262800bf315e244db93265076bb1c2ba8))
* **host-console:** gate Host Console behind Admiral tier ([#277](https://github.com/AnsoCode/Sencho/issues/277)) ([b5d3f49](https://github.com/AnsoCode/Sencho/commit/b5d3f497cb1a09fdc2107f4ef720ebb7f07cbd87))
* **labels:** add stack labels for organizing, filtering, and bulk actions ([#341](https://github.com/AnsoCode/Sencho/issues/341)) ([28e7be6](https://github.com/AnsoCode/Sencho/commit/28e7be652cb18abdd51ca6df8eda2104d213dc30))
* **license:** distributed license enforcement across multi-node setups ([#359](https://github.com/AnsoCode/Sencho/issues/359)) ([6c26ae3](https://github.com/AnsoCode/Sencho/commit/6c26ae3f501d438dcde5331bae588ee6e26c2c3e))
* **multi-node:** warn when configuring remote node with plain HTTP URL ([#292](https://github.com/AnsoCode/Sencho/issues/292)) ([e587256](https://github.com/AnsoCode/Sencho/commit/e587256086997a784007a69d8a7fd56881d0a9b1))
* **nav:** add pulsing animation to local node status dot ([#418](https://github.com/AnsoCode/Sencho/issues/418)) ([8920d8c](https://github.com/AnsoCode/Sencho/commit/8920d8c55a95e3b4e799489dd757627f218a3d11))
* **nodes:** add capability-based node compatibility negotiation ([#350](https://github.com/AnsoCode/Sencho/issues/350)) ([ee75811](https://github.com/AnsoCode/Sencho/commit/ee75811e255e8d5f9ae87117d12c2902185d98f1))
* **nodes:** add per-node scheduling and update visibility ([#344](https://github.com/AnsoCode/Sencho/issues/344)) ([efbd20f](https://github.com/AnsoCode/Sencho/commit/efbd20fed57299acae43ecaee3b1d9ff52da5aae))
* **notifications:** add shared notification routing rules (Admiral tier) ([#347](https://github.com/AnsoCode/Sencho/issues/347)) ([1b573f5](https://github.com/AnsoCode/Sencho/commit/1b573f542a36cde3e94c05f285d34330df96edb1))
* **notifications:** aggregate alerts from all connected nodes in the notification panel ([16f55bb](https://github.com/AnsoCode/Sencho/commit/16f55bbb40fedc4e8ae6344671ddd016faf78151))
* **notifications:** aggregate alerts from all nodes in the notification panel ([1690f0d](https://github.com/AnsoCode/Sencho/commit/1690f0d3c6b80f0825d71d32f4c6bdd3f07a1290))
* **notifications:** replace polling with WebSocket push ([4d1aef7](https://github.com/AnsoCode/Sencho/commit/4d1aef744b8fe9195ceb5dcafbaf593d216ff8e0))
* **notifications:** replace polling with WebSocket push ([a5ac3e4](https://github.com/AnsoCode/Sencho/commit/a5ac3e4981383eda70f4817c530e89872c3639b6))
* RBAC, atomic deployments, and fleet-wide backups (Pro) ([#181](https://github.com/AnsoCode/Sencho/issues/181)) ([db73d76](https://github.com/AnsoCode/Sencho/commit/db73d7671a22b72756a16594004d9767970d4190))
* RBAC, atomic deployments, fleet backups, and licensing (Pro) ([#185](https://github.com/AnsoCode/Sencho/issues/185)) ([32a7d53](https://github.com/AnsoCode/Sencho/commit/32a7d53b2b1b9b3d2a067433c9e77709ade96697))
* **rbac:** add Deployer & Node Admin roles with scoped permissions (Team Pro) ([#253](https://github.com/AnsoCode/Sencho/issues/253)) ([8380fba](https://github.com/AnsoCode/Sencho/commit/8380fbad4b617b004e2d2f19595d1490eaa1e005))
* **registries:** add private registry credential management (Team Pro) ([#240](https://github.com/AnsoCode/Sencho/issues/240)) ([244c83a](https://github.com/AnsoCode/Sencho/commit/244c83a0c3102a797658d35d087bf47366f6df75))
* **release:** sign and attest published docker images ([#480](https://github.com/AnsoCode/Sencho/issues/480)) ([2a2efb8](https://github.com/AnsoCode/Sencho/commit/2a2efb847e1847908e2f3ab9d0c38da01f36bd0b))
* **resources:** add loading toast for prune, delete, and purge operations ([#426](https://github.com/AnsoCode/Sencho/issues/426)) ([f6d2199](https://github.com/AnsoCode/Sencho/commit/f6d219997875be46c5c207a7960dd13dad118f3e))
* **resources:** add network management with create, inspect, and topology ([#338](https://github.com/AnsoCode/Sencho/issues/338)) ([24299a0](https://github.com/AnsoCode/Sencho/commit/24299a0115ce0371f44608f8d64248e6474df8ce))
* **resources:** add network management with create, inspect, and topology visualization ([#335](https://github.com/AnsoCode/Sencho/issues/335)) ([4488637](https://github.com/AnsoCode/Sencho/commit/4488637656b8a19f8df2fcea7ffafff023786068))
* **resources:** managed/unmanaged resource separation across Resources Hub ([2a444bd](https://github.com/AnsoCode/Sencho/commit/2a444bde99e13b2e94fa2476f463399840d0e3bf))
* **resources:** managed/unmanaged resource separation across Resources Hub ([5191737](https://github.com/AnsoCode/Sencho/commit/5191737d5365fcc607358993298aad40ab7c2d26))
* **scheduled-ops:** add failure notifications, granular targeting, and history export ([#286](https://github.com/AnsoCode/Sencho/issues/286)) ([eccdd1b](https://github.com/AnsoCode/Sencho/commit/eccdd1b87903c17af822edb0cdb4236812929bd2))
* **scheduled-ops:** add scheduled operations for Team Pro users ([#231](https://github.com/AnsoCode/Sencho/issues/231)) ([31e1795](https://github.com/AnsoCode/Sencho/commit/31e1795af06beaa68ec6e2240d83b7656ab549f7))
* **settings:** harden settings API and overhaul SettingsModal ([23a2259](https://github.com/AnsoCode/Sencho/commit/23a22598abb9185996b6180cb2c78f0311efd4c6))
* **settings:** harden settings API and overhaul SettingsModal ([322e717](https://github.com/AnsoCode/Sencho/commit/322e7175140b1b11db79854d43c322fe2b860b93))
* **settings:** replace static license CTA with dynamic upgrade cards ([#201](https://github.com/AnsoCode/Sencho/issues/201)) ([d3828e8](https://github.com/AnsoCode/Sencho/commit/d3828e885d78b23902a3a82186dcd009e3f2c0d9))
* **settings:** scope split — developer settings always target local node ([f7e8e40](https://github.com/AnsoCode/Sencho/commit/f7e8e409158e038404d4a531331b09d7c37f5113))
* SSO & LDAP authentication for Team Pro ([#209](https://github.com/AnsoCode/Sencho/issues/209)) ([bd4008f](https://github.com/AnsoCode/Sencho/commit/bd4008f5091122f74967b4debdd4c4f046693f46))
* stack context menu, tier icons, centered logo & support ([#194](https://github.com/AnsoCode/Sencho/issues/194)) ([dda1671](https://github.com/AnsoCode/Sencho/commit/dda1671e5a4c6788ba5ad97b00cbac98910f3ef0))
* **stack-management:** add scan stacks folder button ([#332](https://github.com/AnsoCode/Sencho/issues/332)) ([6f74153](https://github.com/AnsoCode/Sencho/commit/6f7415351f648120ab4039f1fcc9a1226cfa52f4))
* **stacks:** per-stack action tracking, optimistic status, and bulk status endpoint ([#362](https://github.com/AnsoCode/Sencho/issues/362)) ([dfd4d28](https://github.com/AnsoCode/Sencho/commit/dfd4d2858a023ed013afbe93c077a3152a0773c5))
* **stacks:** state-aware sidebar context menu and Open App action ([#368](https://github.com/AnsoCode/Sencho/issues/368)) ([55d3b8c](https://github.com/AnsoCode/Sencho/commit/55d3b8ca1dea6958cecf9d1672a6d891751f7ae3))
* **topology:** overhaul network topology with dagre layout, enriched nodes, and click-to-logs ([#447](https://github.com/AnsoCode/Sencho/issues/447)) ([3ee4fe6](https://github.com/AnsoCode/Sencho/commit/3ee4fe6e447a503c94d3199ab93c2504ee58a7da))
* UI polish sprint — 7 items + logs toolbar redesign ([#365](https://github.com/AnsoCode/Sencho/issues/365)) ([f9ebd1d](https://github.com/AnsoCode/Sencho/commit/f9ebd1d77c74434e641e2fc41f4f6d3de8cbeeee))
* **ui:** glassmorphism redesign with settings decomposition ([#274](https://github.com/AnsoCode/Sencho/issues/274)) ([7637091](https://github.com/AnsoCode/Sencho/commit/7637091e84838047c462e3dbce38122d4c24d007))
* **ui:** redesign top bar with three-zone navigation layout ([#237](https://github.com/AnsoCode/Sencho/issues/237)) ([b7e7ee8](https://github.com/AnsoCode/Sencho/commit/b7e7ee8f55ec6bf89acc7bb54d47eab12ac940c5))
* **ui:** theme-aware sidebar logo with dark/light variants ([#74](https://github.com/AnsoCode/Sencho/issues/74)) ([b25574a](https://github.com/AnsoCode/Sencho/commit/b25574a427fcfabd69d13f7515e100fe652fbef7))
* **webhooks:** add CI/CD webhook integration for triggering stack actions (Pro) ([#177](https://github.com/AnsoCode/Sencho/issues/177)) ([4fc3633](https://github.com/AnsoCode/Sencho/commit/4fc363301a1aaa442adbed83aebd21ca0e71c9c5))


### Fixed

* add --exclude='.git' to the rsync invocation. ([8902f6f](https://github.com/AnsoCode/Sencho/commit/8902f6fb4ccddb06f8dec7ef193fca817d2e686a))
* add linux/arm64 platform to Docker build for ARM server support ([12467c3](https://github.com/AnsoCode/Sencho/commit/12467c3fc1d19f43eb234802944300d7a36ccf56))
* **alerts:** overhaul alerts & notifications system for local and remote nodes ([33c4976](https://github.com/AnsoCode/Sencho/commit/33c4976dc78832e0c8a53c92b1ad03ba01c44175))
* **alerts:** overhaul alerts & notifications system for local and remote nodes ([e190f3a](https://github.com/AnsoCode/Sencho/commit/e190f3ad8a0532d400a59216ccdc32218e7568c0))
* **api-tokens:** harden scope enforcement and add expiration support ([#224](https://github.com/AnsoCode/Sencho/issues/224)) ([954994c](https://github.com/AnsoCode/Sencho/commit/954994cdc01e5cee3e65153c2a302afed2da2b44))
* **api-tokens:** harden scope enforcement and block sensitive endpoints ([#228](https://github.com/AnsoCode/Sencho/issues/228)) ([5b607de](https://github.com/AnsoCode/Sencho/commit/5b607de227eecf4000208b347d8157f2d5d94651))
* **api:** add tiered rate limiting to prevent polling lockouts ([#460](https://github.com/AnsoCode/Sencho/issues/460)) ([8e1b982](https://github.com/AnsoCode/Sencho/commit/8e1b9826cf2eb4128d7e9d6d1c667db7c664728f))
* **auto-update:** proxy update execution to remote nodes via Distributed API ([#419](https://github.com/AnsoCode/Sencho/issues/419)) ([ca8f227](https://github.com/AnsoCode/Sencho/commit/ca8f22734d1c6f960cf564cf9fa9588396fbd1fd))
* **billing:** hide billing portal for lifetime licenses ([#427](https://github.com/AnsoCode/Sencho/issues/427)) ([be7eda8](https://github.com/AnsoCode/Sencho/commit/be7eda85f19afe34c311f1fcf751f9a3180cc837))
* **charts:** suppress Recharts dimension warnings on initial render ([#141](https://github.com/AnsoCode/Sencho/issues/141)) ([c6633b0](https://github.com/AnsoCode/Sencho/commit/c6633b0245d10671aac78fedac875be63c62a1e1))
* **ci:** add linux/arm64 Docker build support with QEMU optimization ([#76](https://github.com/AnsoCode/Sencho/issues/76)) ([278f7f1](https://github.com/AnsoCode/Sencho/commit/278f7f18d91ccae8afda48275e8e62b9c2b86d4f))
* **ci:** add load: true to buildx so Trivy can find the built image ([353fd25](https://github.com/AnsoCode/Sencho/commit/353fd253e93356720243f2ccde8b34a5801cfc10))
* **ci:** correct release-please changelog section names and tag format ([ea57cbe](https://github.com/AnsoCode/Sencho/commit/ea57cbe97f7f4166c747f3e3710f85e57ab476a1))
* **ci:** correct release-please changelog section names and tag format ([ea57cbe](https://github.com/AnsoCode/Sencho/commit/ea57cbe97f7f4166c747f3e3710f85e57ab476a1))
* **ci:** correct release-please changelog section names and tag format ([e653bc2](https://github.com/AnsoCode/Sencho/commit/e653bc2210f07d83fcf16ca97e3c2863a40e2cdf))
* **ci:** docker-publish tag trigger ([6cd84ba](https://github.com/AnsoCode/Sencho/commit/6cd84ba9c6b40f2a1630e783c49b397e6d6969dc))
* **ci:** docker-publish tag trigger + re-release v0.1.0 ([6cd84ba](https://github.com/AnsoCode/Sencho/commit/6cd84ba9c6b40f2a1630e783c49b397e6d6969dc))
* **ci:** exclude .git from rsync --delete in sync-docs ([aefeb7a](https://github.com/AnsoCode/Sencho/commit/aefeb7a35febb6fb33843f2c407fce70b40bcb56))
* **ci:** exclude .git from rsync --delete in sync-docs ([8902f6f](https://github.com/AnsoCode/Sencho/commit/8902f6fb4ccddb06f8dec7ef193fca817d2e686a))
* **ci:** fix sync-docs empty-repo crash and update-screenshots protected-branch push ([bed63f8](https://github.com/AnsoCode/Sencho/commit/bed63f8b4725065988254c5d5113866033de38ac))
* **ci:** fix sync-docs empty-repo crash and update-screenshots protected-branch push ([9505132](https://github.com/AnsoCode/Sencho/commit/9505132aaf3c1457383040f5356f6c1d9d4296d0))
* **ci:** fix update-screenshots token and sync-docs empty-repo handling ([392a49e](https://github.com/AnsoCode/Sencho/commit/392a49e0bd27894249f918b6a918b0642ae7c41f))
* **ci:** fix update-screenshots token and sync-docs empty-repo handling ([b24863d](https://github.com/AnsoCode/Sencho/commit/b24863db66ffdc015f723d8c24428f271fcd98b4))
* **ci:** release-please config corrections ([b6391b9](https://github.com/AnsoCode/Sencho/commit/b6391b96ffd4edf7a303350f7416ab1945136e1b))
* **ci:** release-please config corrections ([b6391b9](https://github.com/AnsoCode/Sencho/commit/b6391b96ffd4edf7a303350f7416ab1945136e1b))
* **ci:** trigger docker-publish on v* tag push instead of GitHub Release event ([c8047c2](https://github.com/AnsoCode/Sencho/commit/c8047c209cfb98fd56e7484b5db01f564aa6d027))
* **ci:** trigger docker-publish on v* tag push instead of GitHub Release event ([c8047c2](https://github.com/AnsoCode/Sencho/commit/c8047c209cfb98fd56e7484b5db01f564aa6d027))
* **ci:** trigger docker-publish on v* tag push instead of GitHub Release event ([6c911fd](https://github.com/AnsoCode/Sencho/commit/6c911fd67fa55548173678f08504541fede52299))
* **ci:** update lock files after adding ESLint deps and fixing high CVEs ([3cf9f02](https://github.com/AnsoCode/Sencho/commit/3cf9f023d3f5bc798bfbea5ffeebaee940dfe546))
* **ci:** use double-quoted string for if condition to fix YAML parse error ([f5c5eda](https://github.com/AnsoCode/Sencho/commit/f5c5eda30a65ba7fc4443a1a927f818e339c34f4))
* **ci:** YAML syntax error and sync-docs git directory failure ([dfa93c0](https://github.com/AnsoCode/Sencho/commit/dfa93c0bba9f3cbf684140b9a456359c6745a98f))
* **ci:** YAML syntax error in if condition and safe.directory for sync-docs ([dc79683](https://github.com/AnsoCode/Sencho/commit/dc79683b01690cfe16293660481aa5fdb030603d))
* **compose:** move atomic backup out of stack folder, silence stale stats 404s ([#498](https://github.com/AnsoCode/Sencho/issues/498)) ([ba9c4f4](https://github.com/AnsoCode/Sencho/commit/ba9c4f4aa62f44b4631e2478e03618b2e59891d5))
* **console:** send proxy tier headers for remote node console-token requests ([#424](https://github.com/AnsoCode/Sencho/issues/424)) ([2354bee](https://github.com/AnsoCode/Sencho/commit/2354beed02b52ef4ddd90a861e0037e7d3d090b8))
* **csp:** allow external images in App Store and suppress console warnings ([#138](https://github.com/AnsoCode/Sencho/issues/138)) ([c5217cd](https://github.com/AnsoCode/Sencho/commit/c5217cd96de3dd8d2971668373b6eabd2c1654a4))
* **dashboard:** correct stale Stats reset with inactive field ([0d5dc57](https://github.com/AnsoCode/Sencho/commit/0d5dc574a42e6550bf0e58cc5f60988a970201db))
* **db:** recreate stack_update_status table with composite primary key ([#356](https://github.com/AnsoCode/Sencho/issues/356)) ([4fe4ac5](https://github.com/AnsoCode/Sencho/commit/4fe4ac5d19cddc7db3d05563e8977d0c70d963f2))
* **deps:** migrate SSO OIDC code to openid-client v6 ([#492](https://github.com/AnsoCode/Sencho/issues/492)) ([12fe79f](https://github.com/AnsoCode/Sencho/commit/12fe79fc85cf44f3723424b70a9e2d76d1c32b11))
* **docker:** add entrypoint for volume permission handling ([593a709](https://github.com/AnsoCode/Sencho/commit/593a7091978a2024080ef1bbd394d86acb185b17))
* **docker:** entrypoint for volume permission handling ([c743f6c](https://github.com/AnsoCode/Sencho/commit/c743f6cd45ed8adf97e5bc49f88dbb4b69b41561))
* **docker:** fix xx cross-compilation sysroot for native modules ([#80](https://github.com/AnsoCode/Sencho/issues/80)) ([381701e](https://github.com/AnsoCode/Sencho/commit/381701ee258727b24031c09695c11bdf2cc7c854))
* **docker:** fix xx cross-compilation sysroot for node-pty and C++ modules ([518b0af](https://github.com/AnsoCode/Sencho/commit/518b0afb85023dbd32d7e90bdebaa139f9688d44))
* **docker:** install Docker CLI v29.3.1 from static binaries to resolve CVEs ([#268](https://github.com/AnsoCode/Sencho/issues/268)) ([f9b86e6](https://github.com/AnsoCode/Sencho/commit/f9b86e6f53e83ea0b5e8de7c1c916196d3345aee))
* **docker:** repair broken entrypoint from bad merge conflict resolution ([987fc3d](https://github.com/AnsoCode/Sencho/commit/987fc3d3396f7d66d5b847bb2700be5e87c20af4))
* **docker:** replace QEMU npm execution with tonistiigi/xx cross-compilation ([#78](https://github.com/AnsoCode/Sencho/issues/78)) ([1e0014e](https://github.com/AnsoCode/Sencho/commit/1e0014e1832653a0d8ce23182a2c2c7ef9efde2e))
* **docker:** upgrade Compose v2.40.3 → v5.1.1 to remediate dependency CVEs ([#283](https://github.com/AnsoCode/Sencho/issues/283)) ([36ebd5a](https://github.com/AnsoCode/Sencho/commit/36ebd5a9c1c82b5d7631d32831ac8ac420b0c782))
* **docker:** use native g++ for same-platform builds, xx-clang only for cross ([f23d8c6](https://github.com/AnsoCode/Sencho/commit/f23d8c660dc817f8e4486e656a38aadd9e6e5414))
* **e2e:** fill api_token in nodes tests so submit button is enabled ([707a5e8](https://github.com/AnsoCode/Sencho/commit/707a5e81c1865a45ee1789b7d43fa08eeb81b00b))
* **e2e:** fix stacks timeout and nodes skip in CI ([14c24c8](https://github.com/AnsoCode/Sencho/commit/14c24c82456cd8792cfb5d9f45d6c27b35dac32e))
* **e2e:** fully rewrite nodes tests to handle Radix UI Select and remote type flow ([12bbe51](https://github.com/AnsoCode/Sencho/commit/12bbe51a3af2ef8e48b5165b48026dd4566e9777))
* **e2e:** get all E2E tests passing and fix AlertDialog crash on delete ([f7471a1](https://github.com/AnsoCode/Sencho/commit/f7471a1a18f28c20e903b838ab4bcc8f8e0b73f8))
* **e2e:** use #node-name locator instead of getByLabel in nodes tests ([e01c0d6](https://github.com/AnsoCode/Sencho/commit/e01c0d6b4818c815897fd13b6ec319721a226b73))
* **e2e:** use button role for Resources nav item in screenshots spec ([b0e2b2d](https://github.com/AnsoCode/Sencho/commit/b0e2b2d025b86fca26b193f3eeda7e20c285da53))
* **e2e:** wait for sidebar stacks to finish loading before assertions ([#149](https://github.com/AnsoCode/Sencho/issues/149)) ([9ba9a3a](https://github.com/AnsoCode/Sencho/commit/9ba9a3a4565702135f22736a6b2310fc0da1d2f1))
* **editor:** bundle Monaco locally to fix stuck Loading state ([0eaa45b](https://github.com/AnsoCode/Sencho/commit/0eaa45bd7f5a4b5db9d51a577d25175bbcb4ff77))
* **editor:** bundle Monaco locally to fix stuck Loading state ([0eaa45b](https://github.com/AnsoCode/Sencho/commit/0eaa45bd7f5a4b5db9d51a577d25175bbcb4ff77))
* **editor:** bundle Monaco locally to fix stuck Loading state and CSP block ([79fde6e](https://github.com/AnsoCode/Sencho/commit/79fde6e2bd598085abfc7c702f5745bdfd692aec))
* **editor:** ESLint unused params fix ([dd5b698](https://github.com/AnsoCode/Sencho/commit/dd5b698b3f96e643af608a36128f05874a3b1f3c))
* **editor:** ESLint unused params fix ([dd5b698](https://github.com/AnsoCode/Sencho/commit/dd5b698b3f96e643af608a36128f05874a3b1f3c))
* **editor:** Monaco CSP fix + release pipeline fixes ([36a9bf3](https://github.com/AnsoCode/Sencho/commit/36a9bf3109c096ddd5d8095089a6ffb7bd6dee8d))
* **editor:** Monaco CSP fix + release pipeline fixes — v0.2.1 ([36a9bf3](https://github.com/AnsoCode/Sencho/commit/36a9bf3109c096ddd5d8095089a6ffb7bd6dee8d))
* **editor:** remove unused params from getWorker to satisfy ESLint ([34172a9](https://github.com/AnsoCode/Sencho/commit/34172a99226a4810465968ff9d238b85b1430829))
* **editor:** remove unused params from getWorker to satisfy ESLint ([34172a9](https://github.com/AnsoCode/Sencho/commit/34172a99226a4810465968ff9d238b85b1430829))
* **editor:** remove unused params from getWorker to satisfy ESLint ([59290e9](https://github.com/AnsoCode/Sencho/commit/59290e9e9d00cc97698e0223ab2810ae9f7b06d2))
* **env:** resolve 404 when loading env files and CSP inline script violation ([#134](https://github.com/AnsoCode/Sencho/issues/134)) ([1e6367a](https://github.com/AnsoCode/Sencho/commit/1e6367a147dddb323799a3cd1947507c595d21db))
* **error-handling:** surface silent errors across the codebase ([#326](https://github.com/AnsoCode/Sencho/issues/326)) ([10597d2](https://github.com/AnsoCode/Sencho/commit/10597d213a5dfdc47dddd53998336fb09889962b))
* **fleet:** add Docker Hub fallback for version detection on private repos ([#463](https://github.com/AnsoCode/Sencho/issues/463)) ([8adcef8](https://github.com/AnsoCode/Sencho/commit/8adcef8e4744a16e08a0841b6c5b8e775e92f36f))
* **fleet:** capture local self-update helper errors ([#495](https://github.com/AnsoCode/Sencho/issues/495)) ([4003e7c](https://github.com/AnsoCode/Sencho/commit/4003e7c04730c8ff3d2f8ae9f1885f020aafc8db))
* **fleet:** detect updates via GitHub Releases instead of gateway self-comparison ([#454](https://github.com/AnsoCode/Sencho/issues/454)) ([368bef2](https://github.com/AnsoCode/Sencho/commit/368bef20d3512165b74848ecea4669605fcea88a))
* **fleet:** filter invalid version strings from UI display ([#399](https://github.com/AnsoCode/Sencho/issues/399)) ([2089e75](https://github.com/AnsoCode/Sencho/commit/2089e75ef1e973f3e04aa6cc448211db35d95848))
* **fleet:** forward host bind mounts to self-update helper container ([#509](https://github.com/AnsoCode/Sencho/issues/509)) ([023e962](https://github.com/AnsoCode/Sencho/commit/023e962a26c6b07eff167cf26d48ea97d455464f))
* **fleet:** make local self-update flow reliable end-to-end ([#472](https://github.com/AnsoCode/Sencho/issues/472)) ([3d69746](https://github.com/AnsoCode/Sencho/commit/3d69746eee96698b3f805dcbea11eef81836d155))
* **fleet:** navigate to editor instead of dashboard on "Open in Editor" click ([#289](https://github.com/AnsoCode/Sencho/issues/289)) ([71ce6b3](https://github.com/AnsoCode/Sencho/commit/71ce6b3e1b6cb974d44279e503f9a158d027555a))
* **fleet:** prevent modal flash when clicking Recheck button ([#457](https://github.com/AnsoCode/Sencho/issues/457)) ([8de82ed](https://github.com/AnsoCode/Sencho/commit/8de82ed81f52b00b537788edc1dd134fede986a9))
* **fleet:** resolve ENOENT when triggering remote node self-update ([#413](https://github.com/AnsoCode/Sencho/issues/413)) ([1b890b4](https://github.com/AnsoCode/Sencho/commit/1b890b4d03f1e3dcf813cb74105192f49328df17))
* **fleet:** resolve getSenchoVersion crash in Docker containers ([#391](https://github.com/AnsoCode/Sencho/issues/391)) ([d437a19](https://github.com/AnsoCode/Sencho/commit/d437a195b695f6cb60411db8dbf1f23f22e298db))
* **fleet:** resolve getSenchoVersion crash in Docker containers ([#396](https://github.com/AnsoCode/Sencho/issues/396)) ([670a429](https://github.com/AnsoCode/Sencho/commit/670a42916899954f805ddb0aa50d106e5617d037))
* **fleet:** resolve remote node capability detection failures ([#388](https://github.com/AnsoCode/Sencho/issues/388)) ([dee7c66](https://github.com/AnsoCode/Sencho/commit/dee7c6685b22b3daf9e57363564133f6d7f0639f))
* **fleet:** resolve self-update compose file access and improve completion detection ([#441](https://github.com/AnsoCode/Sencho/issues/441)) ([6fff2c2](https://github.com/AnsoCode/Sencho/commit/6fff2c2d35dcc4fb13a363c803b5c16e24879694))
* **fleet:** resolve stuck update states and improve detection ([#405](https://github.com/AnsoCode/Sencho/issues/405)) ([cc2da99](https://github.com/AnsoCode/Sencho/commit/cc2da99d6f2ac4fad5fba03006377f54262a6dd2))
* **fleet:** resolve version detection pipeline for Docker builds ([#402](https://github.com/AnsoCode/Sencho/issues/402)) ([a55d124](https://github.com/AnsoCode/Sencho/commit/a55d1245f88b377a6a940cee38bc673987465d75))
* **fleet:** resolve version detection using package.json over stale generated constant ([#410](https://github.com/AnsoCode/Sencho/issues/410)) ([8ba4532](https://github.com/AnsoCode/Sencho/commit/8ba4532995bd8c92c92dae2a2c05b5d8c6abc4d5))
* **fleet:** strip trailing slash in fetchRemoteMeta URL construction ([#444](https://github.com/AnsoCode/Sencho/issues/444)) ([8080540](https://github.com/AnsoCode/Sencho/commit/80805408818e1943613efa7df4ae2a3d1c239018))
* gate SSO and Audit behind Team Pro license tier ([#213](https://github.com/AnsoCode/Sencho/issues/213)) ([8d48b0a](https://github.com/AnsoCode/Sencho/commit/8d48b0abff08195a436f98bf8d42c45de51930df))
* **license:** default 14-day trial to Personal Pro instead of Team Pro ([#216](https://github.com/AnsoCode/Sencho/issues/216)) ([f99abe9](https://github.com/AnsoCode/Sencho/commit/f99abe907d5a39f4f32fb08bf25eda9b00dae88b))
* **licensing:** backward-compatible tier/variant enforcement and self-healing variant detection ([#385](https://github.com/AnsoCode/Sencho/issues/385)) ([9e0c9d3](https://github.com/AnsoCode/Sencho/commit/9e0c9d3f2d59f3330becc2153e2b638823c96b10))
* **licensing:** rename variant values to skipper/admiral and store resolved type ([#379](https://github.com/AnsoCode/Sencho/issues/379)) ([797623e](https://github.com/AnsoCode/Sencho/commit/797623e56fb97e6233f27fb9cc5be12613672707))
* **licensing:** resolve Admiral variant detection and lifetime license handling ([#376](https://github.com/AnsoCode/Sencho/issues/376)) ([f841c40](https://github.com/AnsoCode/Sencho/commit/f841c402b2e75874b066400adadcd8dcdfa9ac5f))
* **licensing:** resolve variant from product_name when variant_name lacks tier info ([#382](https://github.com/AnsoCode/Sencho/issues/382)) ([b08f698](https://github.com/AnsoCode/Sencho/commit/b08f698e8f1a2578bdecd274e923f63818239dd1))
* **lint:** resolve all backend ESLint errors to pass CI lint step ([e876a91](https://github.com/AnsoCode/Sencho/commit/e876a91a2e54267b82805731722f4a80ff2ad193))
* **lint:** resolve all ESLint errors to pass CI lint step ([c8a54a9](https://github.com/AnsoCode/Sencho/commit/c8a54a988bc86ea6a9acf05a116e571a735cd4a3))
* **logs:** cap DOM rendering to 300 rows to prevent browser OOM crash ([ec3a249](https://github.com/AnsoCode/Sencho/commit/ec3a2495a2cf71feb1bd8880a8a2ee1d2cc46c10))
* **merge:** resolve CHANGELOG conflict with develop ([9f0257e](https://github.com/AnsoCode/Sencho/commit/9f0257e94fb6dddaa2287103e0f6bad7b3f3fac9))
* **nav:** remove toggle behavior on navigation tabs ([#417](https://github.com/AnsoCode/Sencho/issues/417)) ([5b06992](https://github.com/AnsoCode/Sencho/commit/5b06992e055a8a30c2b3f1cf746cbd2c9b099061))
* **proxy:** prevent remote 401 from triggering local session logout ([278aa22](https://github.com/AnsoCode/Sencho/commit/278aa2298f2874cb5b86c5e38d6e550a792b689b))
* **proxy:** prevent remote 401 from triggering local session logout ([aeefd79](https://github.com/AnsoCode/Sencho/commit/aeefd79b50eb8a864db69ef1625e2a905a521db2))
* **proxy:** re-stream express.json()-consumed body to remote nodes for POST/PUT/PATCH ([a703707](https://github.com/AnsoCode/Sencho/commit/a703707aa0b5bd30cb6715c0371b6822ced353f3))
* **proxy:** skip express.json() for remote proxy requests to fix body forwarding ([ed69543](https://github.com/AnsoCode/Sencho/commit/ed6954307b82370fb8205f359eb412efaaf38d63))
* remediate Dependabot and Docker Scout security vulnerabilities ([#265](https://github.com/AnsoCode/Sencho/issues/265)) ([59fd528](https://github.com/AnsoCode/Sencho/commit/59fd5285351c14f6e9cde073bd983de073fa3a75))
* **resources:** unify container/resource classification with multi-fallback resolution ([#425](https://github.com/AnsoCode/Sencho/issues/425)) ([662bc1a](https://github.com/AnsoCode/Sencho/commit/662bc1a210386e32cd24b33f155ecf6adfda6d8f))
* run as root by default to eliminate stack-folder permission failures ([#501](https://github.com/AnsoCode/Sencho/issues/501)) ([9eb945a](https://github.com/AnsoCode/Sencho/commit/9eb945a6f0a1481b3bf6f06cef28a06474f7fa6c))
* **scheduled-ops:** audit log text, run attribution, prune targets, and pagination ([#234](https://github.com/AnsoCode/Sencho/issues/234)) ([330eec4](https://github.com/AnsoCode/Sencho/commit/330eec4bff6f194aafdcbe499ab893bef06254b6))
* **schedules:** filter auto-update policies from Scheduled Operations view ([#420](https://github.com/AnsoCode/Sencho/issues/420)) ([455bfa8](https://github.com/AnsoCode/Sencho/commit/455bfa8734bf70ffad54b6fc3192ba1f9f16ce39))
* **security:** disable COOP header and Vite module-preload polyfill ([c36ee93](https://github.com/AnsoCode/Sencho/commit/c36ee9341630b3170c17a03d60bab90d387d09be))
* **security:** disable COOP header and Vite module-preload polyfill ([35a57e5](https://github.com/AnsoCode/Sencho/commit/35a57e5fa7ccbaa735cb3f684993b313cb465792))
* **security:** enforce stack name validation on all routes ([#314](https://github.com/AnsoCode/Sencho/issues/314)) ([1ab04be](https://github.com/AnsoCode/Sencho/commit/1ab04be235cc0d3020d17dfb3028e4679206b886))
* **security:** explicitly disable upgrade-insecure-requests via Helmet 8 API ([50df5b3](https://github.com/AnsoCode/Sencho/commit/50df5b3c028cc7dea75f93b994a6feb908988849))
* **security:** harden encryption key permissions, increase password minimum, remove sensitive logs ([#323](https://github.com/AnsoCode/Sencho/issues/323)) ([f317a83](https://github.com/AnsoCode/Sencho/commit/f317a83814fda3a98eb009c1a05a955bfadd6f0d))
* **security:** pre-launch security hardening audit & remediation ([#320](https://github.com/AnsoCode/Sencho/issues/320)) ([2d6b4c2](https://github.com/AnsoCode/Sencho/commit/2d6b4c233daa178de485dfeb198fc90376949ca4))
* **security:** prevent path traversal via env_file resolution ([#311](https://github.com/AnsoCode/Sencho/issues/311)) ([dc545dd](https://github.com/AnsoCode/Sencho/commit/dc545dd61337904e26e18e5e5bed190675432406))
* **security:** remove CSP upgrade-insecure-requests and HSTS for HTTP deployments ([25012a0](https://github.com/AnsoCode/Sencho/commit/25012a07caa7b545cbdbbdb033778cccc42a618c))
* **security:** remove CSP upgrade-insecure-requests and HSTS over HTTP ([cf2946c](https://github.com/AnsoCode/Sencho/commit/cf2946cfa67157db716e15544fdd547945ec0c3e))
* **settings:** prevent X button overlap and add tooltip to Always Local badge ([ed0817b](https://github.com/AnsoCode/Sencho/commit/ed0817b2c59187b3a1ac9dc52a9ce6ec6e3427bd))
* **sidebar:** resolve stacks showing unknown status when compose name field is set ([#416](https://github.com/AnsoCode/Sencho/issues/416)) ([88011e1](https://github.com/AnsoCode/Sencho/commit/88011e1b16975033e9212de3d61aa4987237ead2))
* **stacks:** avoid resource busy error in Docker fallback deletion ([#271](https://github.com/AnsoCode/Sencho/issues/271)) ([10d1636](https://github.com/AnsoCode/Sencho/commit/10d16361fae2869367a9f757bfc0ab4c3e04ca2c))
* **stacks:** resolve permission denied error on stack deletion ([#261](https://github.com/AnsoCode/Sencho/issues/261)) ([116f15d](https://github.com/AnsoCode/Sencho/commit/116f15dae9c3b530145316ea8b2954ed478fed76))
* **stats:** classify managed containers by working_dir instead of project name ([16e978b](https://github.com/AnsoCode/Sencho/commit/16e978bf4e360f59b3f79b7a38194509fcaddda2))
* **stats:** classify managed containers by working_dir instead of project name ([d62ac09](https://github.com/AnsoCode/Sencho/commit/d62ac095031ae203b2d29a1f0caa85a113884da7))
* trigger docs sync on develop instead of main ([7d1b996](https://github.com/AnsoCode/Sencho/commit/7d1b996bb7c10d33330ed645c8cfd1fc302a93e0))
* **ts:** remove unused motion import from alert-dialog ([0dd72b3](https://github.com/AnsoCode/Sencho/commit/0dd72b3eb467598452938133f563042df15c8596))
* **ts:** use type-only import for Node to satisfy verbatimModuleSyntax ([94d6c8f](https://github.com/AnsoCode/Sencho/commit/94d6c8fc0f8f3afce0e95d80f6a75a3884cca2af))
* **ui:** resolve 9 animated design system bugs including Monaco tab height accumulation ([22e6462](https://github.com/AnsoCode/Sencho/commit/22e646286e9321e66101f9aedc89a99edce1d3c4))
* **ui:** settings modal sidebar nav clipped on smaller viewports ([#280](https://github.com/AnsoCode/Sencho/issues/280)) ([9e14ce9](https://github.com/AnsoCode/Sencho/commit/9e14ce999f89052b218d2e3f974644f41355955c))
* **ui:** standardize toast background to match floating overlay glass style ([#451](https://github.com/AnsoCode/Sencho/issues/451)) ([089d43b](https://github.com/AnsoCode/Sencho/commit/089d43b8556c1418e23c93816391a52476edd9db))
* unify caching behind a single CacheService and enable HTTP compression ([#468](https://github.com/AnsoCode/Sencho/issues/468)) ([c0c3212](https://github.com/AnsoCode/Sencho/commit/c0c321227bd5b8b3fb9f992c8cb64182de00056a))
* **ws:** fix remote node console — delegate console session tokens ([6c518ce](https://github.com/AnsoCode/Sencho/commit/6c518cee5a8735dea3f06cc662706b900c8d93f1))
* **ws:** fix remote node console by delegating console session tokens ([30fe77c](https://github.com/AnsoCode/Sencho/commit/30fe77cd5d57b1dbae6a8b40aebf4f14453d571c))


### Security

* harden terminal WebSocket endpoints against three attack vectors ([2e0f3e2](https://github.com/AnsoCode/Sencho/commit/2e0f3e2711e02c2350342e1fdb56878a81658e38))
* pre-release hardening, automated testing, and production readiness ([ce50db0](https://github.com/AnsoCode/Sencho/commit/ce50db0fdee160e20b658f98b5d8fee86215afc3))

## [0.44.1](https://github.com/AnsoCode/Sencho/compare/v0.44.0...v0.44.1) (2026-04-12)


### Fixed

* **fleet:** forward host bind mounts to self-update helper container ([#509](https://github.com/AnsoCode/Sencho/issues/509)) ([023e962](https://github.com/AnsoCode/Sencho/commit/023e962a26c6b07eff167cf26d48ea97d455464f))

## [0.44.0](https://github.com/AnsoCode/Sencho/compare/v0.43.4...v0.44.0) (2026-04-12)


### Added

* home dashboard and Settings Hub polish ([#506](https://github.com/AnsoCode/Sencho/issues/506)) ([622c1f9](https://github.com/AnsoCode/Sencho/commit/622c1f9262800bf315e244db93265076bb1c2ba8))

## [0.43.4](https://github.com/AnsoCode/Sencho/compare/v0.43.3...v0.43.4) (2026-04-11)

### Fixed

* run as root by default to eliminate stack-folder permission failures ([#501](https://github.com/AnsoCode/Sencho/issues/501)) ([9eb945a](https://github.com/AnsoCode/Sencho/commit/9eb945a6f0a1481b3bf6f06cef28a06474f7fa6c))

## [0.43.3](https://github.com/AnsoCode/Sencho/compare/v0.43.2...v0.43.3) (2026-04-11)

### Fixed

* **compose:** move atomic backup out of stack folder, silence stale stats 404s ([#498](https://github.com/AnsoCode/Sencho/issues/498)) ([ba9c4f4](https://github.com/AnsoCode/Sencho/commit/ba9c4f4aa62f44b4631e2478e03618b2e59891d5))

## [0.43.2](https://github.com/AnsoCode/Sencho/compare/v0.43.1...v0.43.2) (2026-04-10)

### Fixed

* **fleet:** capture local self-update helper errors ([#495](https://github.com/AnsoCode/Sencho/issues/495)) ([4003e7c](https://github.com/AnsoCode/Sencho/commit/4003e7c04730c8ff3d2f8ae9f1885f020aafc8db))

## [0.43.1](https://github.com/AnsoCode/Sencho/compare/v0.43.0...v0.43.1) (2026-04-10)

### Fixed

* **deps:** update SSO/OIDC integration for upstream library v6 ([#492](https://github.com/AnsoCode/Sencho/issues/492)) ([12fe79f](https://github.com/AnsoCode/Sencho/commit/12fe79fc85cf44f3723424b70a9e2d76d1c32b11))

## [0.43.0](https://github.com/AnsoCode/Sencho/compare/v0.42.7...v0.43.0) (2026-04-10)

### Added

* **release:** sign and attest published docker images ([#480](https://github.com/AnsoCode/Sencho/issues/480)) ([2a2efb8](https://github.com/AnsoCode/Sencho/commit/2a2efb847e1847908e2f3ab9d0c38da01f36bd0b))

## [0.42.7](https://github.com/AnsoCode/Sencho/compare/v0.42.6...v0.42.7) (2026-04-10)

### Fixed

* **fleet:** make local self-update flow reliable end-to-end ([#472](https://github.com/AnsoCode/Sencho/issues/472)) ([3d69746](https://github.com/AnsoCode/Sencho/commit/3d69746eee96698b3f805dcbea11eef81836d155))

## [0.42.6](https://github.com/AnsoCode/Sencho/compare/v0.42.5...v0.42.6) (2026-04-10)

### Fixed

* unify caching behind a single cache layer and enable HTTP compression ([#468](https://github.com/AnsoCode/Sencho/issues/468)) ([c0c3212](https://github.com/AnsoCode/Sencho/commit/c0c321227bd5b8b3fb9f992c8cb64182de00056a))

## [0.42.5](https://github.com/AnsoCode/Sencho/compare/v0.42.4...v0.42.5) (2026-04-10)

### Fixed

* **fleet:** add Docker Hub fallback for version detection on private repos ([#463](https://github.com/AnsoCode/Sencho/issues/463)) ([8adcef8](https://github.com/AnsoCode/Sencho/commit/8adcef8e4744a16e08a0841b6c5b8e775e92f36f))

## [0.42.4](https://github.com/AnsoCode/Sencho/compare/v0.42.3...v0.42.4) (2026-04-09)

### Fixed

* **api:** add tiered rate limiting to prevent polling lockouts ([#460](https://github.com/AnsoCode/Sencho/issues/460)) ([8e1b982](https://github.com/AnsoCode/Sencho/commit/8e1b9826cf2eb4128d7e9d6d1c667db7c664728f))

## [0.42.3](https://github.com/AnsoCode/Sencho/compare/v0.42.2...v0.42.3) (2026-04-09)

### Fixed

* **fleet:** prevent modal flash when clicking Recheck button ([#457](https://github.com/AnsoCode/Sencho/issues/457)) ([8de82ed](https://github.com/AnsoCode/Sencho/commit/8de82ed81f52b00b537788edc1dd134fede986a9))

## [0.42.2](https://github.com/AnsoCode/Sencho/compare/v0.42.1...v0.42.2) (2026-04-09)

### Fixed

* **fleet:** detect updates via GitHub Releases instead of gateway self-comparison ([#454](https://github.com/AnsoCode/Sencho/issues/454)) ([368bef2](https://github.com/AnsoCode/Sencho/commit/368bef20d3512165b74848ecea4669605fcea88a))

## [0.42.1](https://github.com/AnsoCode/Sencho/compare/v0.42.0...v0.42.1) (2026-04-09)

### Fixed

* **ui:** standardize toast background to match floating overlay glass style ([#451](https://github.com/AnsoCode/Sencho/issues/451)) ([089d43b](https://github.com/AnsoCode/Sencho/commit/089d43b8556c1418e23c93816391a52476edd9db))

## [0.42.0](https://github.com/AnsoCode/Sencho/compare/v0.41.2...v0.42.0) (2026-04-09)

### Added

* **topology:** overhaul network topology with dagre layout, enriched nodes, and click-to-logs ([#447](https://github.com/AnsoCode/Sencho/issues/447)) ([3ee4fe6](https://github.com/AnsoCode/Sencho/commit/3ee4fe6e447a503c94d3199ab93c2504ee58a7da))

## [0.41.2](https://github.com/AnsoCode/Sencho/compare/v0.41.1...v0.41.2) (2026-04-08)

### Fixed

* **fleet:** strip trailing slash in fetchRemoteMeta URL construction ([#444](https://github.com/AnsoCode/Sencho/issues/444)) ([8080540](https://github.com/AnsoCode/Sencho/commit/80805408818e1943613efa7df4ae2a3d1c239018))

## [0.41.1](https://github.com/AnsoCode/Sencho/compare/v0.41.0...v0.41.1) (2026-04-08)

### Fixed

* **fleet:** resolve self-update compose file access and improve completion detection ([#441](https://github.com/AnsoCode/Sencho/issues/441)) ([6fff2c2](https://github.com/AnsoCode/Sencho/commit/6fff2c2d35dcc4fb13a363c803b5c16e24879694))

## [0.41.0](https://github.com/AnsoCode/Sencho/compare/v0.40.0...v0.41.0) (2026-04-08)

### Added

* **contact:** add official contact emails throughout app and docs ([#428](https://github.com/AnsoCode/Sencho/issues/428)) ([8e0857e](https://github.com/AnsoCode/Sencho/commit/8e0857e7f62d89434768da5f57223ae25276b33d))
* **dashboard:** add node badge to Recent Alerts for remote node alerts ([#423](https://github.com/AnsoCode/Sencho/issues/423)) ([a6849ae](https://github.com/AnsoCode/Sencho/commit/a6849aedabc06cd85a74a915445765ff6f857f6f))
* **resources:** add loading toast for prune, delete, and purge operations ([#426](https://github.com/AnsoCode/Sencho/issues/426)) ([f6d2199](https://github.com/AnsoCode/Sencho/commit/f6d219997875be46c5c207a7960dd13dad118f3e))

### Fixed

* **billing:** hide billing portal for lifetime licenses ([#427](https://github.com/AnsoCode/Sencho/issues/427)) ([be7eda8](https://github.com/AnsoCode/Sencho/commit/be7eda85f19afe34c311f1fcf751f9a3180cc837))
* **console:** send proxy tier headers for remote node console-token requests ([#424](https://github.com/AnsoCode/Sencho/issues/424)) ([2354bee](https://github.com/AnsoCode/Sencho/commit/2354beed02b52ef4ddd90a861e0037e7d3d090b8))
* **resources:** unify container/resource classification with multi-fallback resolution ([#425](https://github.com/AnsoCode/Sencho/issues/425)) ([662bc1a](https://github.com/AnsoCode/Sencho/commit/662bc1a210386e32cd24b33f155ecf6adfda6d8f))

## [0.40.0](https://github.com/AnsoCode/Sencho/compare/v0.39.6...v0.40.0) (2026-04-07)

### Added

* **nav:** add pulsing animation to local node status dot ([#418](https://github.com/AnsoCode/Sencho/issues/418)) ([8920d8c](https://github.com/AnsoCode/Sencho/commit/8920d8c55a95e3b4e799489dd757627f218a3d11))

### Fixed

* **auto-update:** proxy update execution to remote nodes via Distributed API ([#419](https://github.com/AnsoCode/Sencho/issues/419)) ([ca8f227](https://github.com/AnsoCode/Sencho/commit/ca8f22734d1c6f960cf564cf9fa9588396fbd1fd))
* **nav:** remove toggle behavior on navigation tabs ([#417](https://github.com/AnsoCode/Sencho/issues/417)) ([5b06992](https://github.com/AnsoCode/Sencho/commit/5b06992e055a8a30c2b3f1cf746cbd2c9b099061))
* **schedules:** filter auto-update policies from Scheduled Operations view ([#420](https://github.com/AnsoCode/Sencho/issues/420)) ([455bfa8](https://github.com/AnsoCode/Sencho/commit/455bfa8734bf70ffad54b6fc3192ba1f9f16ce39))
* **sidebar:** resolve stacks showing unknown status when compose name field is set ([#416](https://github.com/AnsoCode/Sencho/issues/416)) ([88011e1](https://github.com/AnsoCode/Sencho/commit/88011e1b16975033e9212de3d61aa4987237ead2))

## [0.39.6](https://github.com/AnsoCode/Sencho/compare/v0.39.5...v0.39.6) (2026-04-07)

### Fixed

* **fleet:** resolve ENOENT when triggering remote node self-update ([#413](https://github.com/AnsoCode/Sencho/issues/413)) ([1b890b4](https://github.com/AnsoCode/Sencho/commit/1b890b4d03f1e3dcf813cb74105192f49328df17))

## [0.39.5](https://github.com/AnsoCode/Sencho/compare/v0.39.4...v0.39.5) (2026-04-07)

### Fixed

* **fleet:** resolve version detection using package.json over stale generated constant ([#410](https://github.com/AnsoCode/Sencho/issues/410)) ([8ba4532](https://github.com/AnsoCode/Sencho/commit/8ba4532995bd8c92c92dae2a2c05b5d8c6abc4d5))

## [0.39.4](https://github.com/AnsoCode/Sencho/compare/v0.39.3...v0.39.4) (2026-04-07)

### Fixed

* **fleet:** resolve stuck update states and improve detection ([#405](https://github.com/AnsoCode/Sencho/issues/405)) ([cc2da99](https://github.com/AnsoCode/Sencho/commit/cc2da99d6f2ac4fad5fba03006377f54262a6dd2))

## [0.39.3](https://github.com/AnsoCode/Sencho/compare/v0.39.2...v0.39.3) (2026-04-06)

### Fixed

* **fleet:** resolve version detection pipeline for Docker builds ([#402](https://github.com/AnsoCode/Sencho/issues/402)) ([a55d124](https://github.com/AnsoCode/Sencho/commit/a55d1245f88b377a6a940cee38bc673987465d75))

## [0.39.2](https://github.com/AnsoCode/Sencho/compare/v0.39.1...v0.39.2) (2026-04-06)

### Fixed

* **fleet:** filter invalid version strings from UI display ([#399](https://github.com/AnsoCode/Sencho/issues/399)) ([2089e75](https://github.com/AnsoCode/Sencho/commit/2089e75ef1e973f3e04aa6cc448211db35d95848))

## [0.39.1](https://github.com/AnsoCode/Sencho/compare/v0.39.0...v0.39.1) (2026-04-06)

### Fixed

* **fleet:** resolve getSenchoVersion crash in Docker containers ([#396](https://github.com/AnsoCode/Sencho/issues/396)) ([670a429](https://github.com/AnsoCode/Sencho/commit/670a42916899954f805ddb0aa50d106e5617d037))

## [0.39.0](https://github.com/AnsoCode/Sencho/compare/v0.38.6...v0.39.0) (2026-04-06)

### Added

* add automated docs pipeline and scaffold /docs folder ([9496b14](https://github.com/AnsoCode/Sencho/commit/9496b14f723858d7134e90bf27d921791045dacf))
* add Community/Pro licensing, fleet view, and UI reorganization ([#145](https://github.com/AnsoCode/Sencho/issues/145)) ([4f26f22](https://github.com/AnsoCode/Sencho/commit/4f26f22ccef89441be032a266723cf6fca0a488a))
* add dynamic template registry and smart volume path sanitizer ([536a714](https://github.com/AnsoCode/Sencho/commit/536a714d9b9c5f41d694df9f89733356ea61d167))
* add update-screenshots CI job and screenshot capture spec ([ed8b8e3](https://github.com/AnsoCode/Sencho/commit/ed8b8e33b6b52d9cefef9a2a677a9e12a1b34e61))
* Advanced Error Handling & Probes ([b90db01](https://github.com/AnsoCode/Sencho/commit/b90db0124ce168c08c7356a4b94ccb9599c0edc9))
* **api-tokens:** add scoped API tokens for CI/CD automation (Admiral) ([#220](https://github.com/AnsoCode/Sencho/issues/220)) ([8d8118c](https://github.com/AnsoCode/Sencho/commit/8d8118c963a1c3b10872041ea0f645d8f0a65196))
* **api:** add global rate limiter for all API endpoints ([#317](https://github.com/AnsoCode/Sencho/issues/317)) ([b28ebfa](https://github.com/AnsoCode/Sencho/commit/b28ebfa6ffff7fa76657c67e5fdb3494a76bd8a1))
* App Store Polish ([5c7e08a](https://github.com/AnsoCode/Sencho/commit/5c7e08a3912d85c82964ae9bed1e5f56254eacac))
* App Templates & One-Click Installs ([b519fbb](https://github.com/AnsoCode/Sencho/commit/b519fbbddff66cedcd191ccb7d3290cdcfd6f541))
* **app-store:** category filter bar + custom registry settings ([ae4540b](https://github.com/AnsoCode/Sencho/commit/ae4540bf4613c2ae416c828b622bb4e198f1a11f))
* **app-store:** category filter bar and custom registry settings ([34cad76](https://github.com/AnsoCode/Sencho/commit/34cad76d45fe7212bd61aa514f40e13217e2fd8e))
* audit logging, secrets at rest, and legacy cleanup ([#205](https://github.com/AnsoCode/Sencho/issues/205)) ([1799030](https://github.com/AnsoCode/Sencho/commit/179903006035280d5c1655daaf3dbe3384588bf0))
* **audit-log:** add configurable retention, export, Auditor role, and enhanced filtering ([#258](https://github.com/AnsoCode/Sencho/issues/258)) ([d586ce3](https://github.com/AnsoCode/Sencho/commit/d586ce393af34c8cc34cd046d2d90a70e0d79964))
* **auth:** redesign Login and Setup pages with split-panel branding layout ([#153](https://github.com/AnsoCode/Sencho/issues/153)) ([e0319b5](https://github.com/AnsoCode/Sencho/commit/e0319b5daebbae88b942ba55f6891ce0e2ecaf29))
* auto-refresh doc screenshots on develop push ([eaf2177](https://github.com/AnsoCode/Sencho/commit/eaf217720c42a07cce7afadd673178c886717878))
* **auto-update:** add auto-update policies and fix image update detection ([#297](https://github.com/AnsoCode/Sencho/issues/297)) ([28c7a8f](https://github.com/AnsoCode/Sencho/commit/28c7a8fd544f33ea0fbe90f19ed96154743eb527))
* automated docs pipeline ([05a6b93](https://github.com/AnsoCode/Sencho/commit/05a6b93af0b2de04e70565445178873d5f858348))
* **ci:** add release-please automated versioning workflow ([c2d5d37](https://github.com/AnsoCode/Sencho/commit/c2d5d37be41267e71bb8515010b049fcd31f5d6b))
* **ci:** automated versioning with release-please ([c991b81](https://github.com/AnsoCode/Sencho/commit/c991b8121edcd30bd6806e959d0dcd14711f439f))
* **dashboard:** redesign as DevOps command center ([#371](https://github.com/AnsoCode/Sencho/issues/371)) ([2ee959e](https://github.com/AnsoCode/Sencho/commit/2ee959ec3b696c5beba7b8b62bec2221ca65d525))
* Deployment Freedom & Polish ([a6bf1a3](https://github.com/AnsoCode/Sencho/commit/a6bf1a3b9672c098187991e01a47247ee1008f07))
* **design:** animated design system foundation with animate-ui and motion ([c34092f](https://github.com/AnsoCode/Sencho/commit/c34092f8ec07fa84e1bb83775ac767c6cb2dd744))
* **docker:** add linux/arm64 platform support via xx cross-compilation ([cf19390](https://github.com/AnsoCode/Sencho/commit/cf19390fd559a0ee49b9c2b08675565afd715dd5))
* Dynamic Templates & Sanitizer ([c05654b](https://github.com/AnsoCode/Sencho/commit/c05654bdf9eacdd11c35a3eadf10ba8573e40bae))
* Enterprise Logs & Dev Mode ([b32cf54](https://github.com/AnsoCode/Sencho/commit/b32cf5490c36c6ad42dce13c847233d4855d91c3))
* **fleet:** add Pro fleet management features and container drill-down ([#174](https://github.com/AnsoCode/Sencho/issues/174)) ([0630f57](https://github.com/AnsoCode/Sencho/commit/0630f57ca87451352e7c50d511522ac621771458))
* **fleet:** add remote node update management ([#353](https://github.com/AnsoCode/Sencho/issues/353)) ([87b5908](https://github.com/AnsoCode/Sencho/commit/87b59082887902af24ad2bf88ae3d4d4c941411e))
* **host-console:** gate Host Console behind Admiral tier ([#277](https://github.com/AnsoCode/Sencho/issues/277)) ([b5d3f49](https://github.com/AnsoCode/Sencho/commit/b5d3f497cb1a09fdc2107f4ef720ebb7f07cbd87))
* implement app templates storefront and deployment engine ([1676dc2](https://github.com/AnsoCode/Sencho/commit/1676dc22dfc62a4584e4896732a99b951bfb2fe2))
* implement centralized logging and historical metrics dashboard ([a4a5365](https://github.com/AnsoCode/Sencho/commit/a4a5365da1036a5fc381f49d09f353b1bff6ec43))
* implement dynamic volumes, custom env vars, and timezone detection ([f2fbca1](https://github.com/AnsoCode/Sencho/commit/f2fbca17b719f72c139a6e18c420ca8bddfbdb98))
* implement enterprise sse global logs and developer mode ([448a64a](https://github.com/AnsoCode/Sencho/commit/448a64a10deb022a7c96c10fac7463bd83e231e6))
* implement pre-deploy collision checks and universal two-stage t… ([12aab3a](https://github.com/AnsoCode/Sencho/commit/12aab3a5aef1ef2dcb80631646220190919d36a1))
* implement pre-deploy collision checks and universal two-stage teardown ([b979525](https://github.com/AnsoCode/Sencho/commit/b97952567d23448fcc5c0ae3fe2a34e3c704c326))
* implement real-time container log streaming via SSE ([49cef7a](https://github.com/AnsoCode/Sencho/commit/49cef7acfa6cb8176accfa4019933d94f5aa114d))
* implement remote tls/ssh security, isolate system stats, and polish ux ([2a37e11](https://github.com/AnsoCode/Sencho/commit/2a37e114df76a7f09a262b634074c4c190ecd38d))
* implement smart error parser and post-deploy health probe ([953049a](https://github.com/AnsoCode/Sencho/commit/953049a45dfba4f413e71767004f69c601469e43))
* integrate official lsio api and rich template metadata ([f9e8874](https://github.com/AnsoCode/Sencho/commit/f9e8874f6c6ef454912ca69dac12802e59000df5))
* **labels:** add stack labels for organizing, filtering, and bulk actions ([#341](https://github.com/AnsoCode/Sencho/issues/341)) ([28e7be6](https://github.com/AnsoCode/Sencho/commit/28e7be652cb18abdd51ca6df8eda2104d213dc30))
* **license:** distributed license enforcement across multi-node setups ([#359](https://github.com/AnsoCode/Sencho/issues/359)) ([6c26ae3](https://github.com/AnsoCode/Sencho/commit/6c26ae3f501d438dcde5331bae588ee6e26c2c3e))
* **multi-node:** warn when configuring remote node with plain HTTP URL ([#292](https://github.com/AnsoCode/Sencho/issues/292)) ([e587256](https://github.com/AnsoCode/Sencho/commit/e587256086997a784007a69d8a7fd56881d0a9b1))
* **nodes:** add capability-based node compatibility negotiation ([#350](https://github.com/AnsoCode/Sencho/issues/350)) ([ee75811](https://github.com/AnsoCode/Sencho/commit/ee75811e255e8d5f9ae87117d12c2902185d98f1))
* **nodes:** add per-node scheduling and update visibility ([#344](https://github.com/AnsoCode/Sencho/issues/344)) ([efbd20f](https://github.com/AnsoCode/Sencho/commit/efbd20fed57299acae43ecaee3b1d9ff52da5aae))
* **notifications:** add shared notification routing rules (Admiral tier) ([#347](https://github.com/AnsoCode/Sencho/issues/347)) ([1b573f5](https://github.com/AnsoCode/Sencho/commit/1b573f542a36cde3e94c05f285d34330df96edb1))
* **notifications:** aggregate alerts from all connected nodes in the notification panel ([16f55bb](https://github.com/AnsoCode/Sencho/commit/16f55bbb40fedc4e8ae6344671ddd016faf78151))
* **notifications:** aggregate alerts from all nodes in the notification panel ([1690f0d](https://github.com/AnsoCode/Sencho/commit/1690f0d3c6b80f0825d71d32f4c6bdd3f07a1290))
* **notifications:** replace polling with WebSocket push ([4d1aef7](https://github.com/AnsoCode/Sencho/commit/4d1aef744b8fe9195ceb5dcafbaf593d216ff8e0))
* Official LSIO API Integration ([33b4881](https://github.com/AnsoCode/Sencho/commit/33b48811d80a413b394fc85a5f03cfabeed26761))
* polish app store ui and add advanced deployment configuration ([44acfd7](https://github.com/AnsoCode/Sencho/commit/44acfd7d90d283a734b225b086f44d63bfac7e0e))
* RBAC, atomic deployments, and fleet-wide backups (Skipper and Admiral) ([#181](https://github.com/AnsoCode/Sencho/issues/181)) ([db73d76](https://github.com/AnsoCode/Sencho/commit/db73d7671a22b72756a16594004d9767970d4190))
* RBAC, atomic deployments, fleet backups, and licensing (Skipper and Admiral) ([#185](https://github.com/AnsoCode/Sencho/issues/185)) ([32a7d53](https://github.com/AnsoCode/Sencho/commit/32a7d53b2b1b9b3d2a067433c9e77709ade96697))
* **rbac:** add Deployer & Node Admin roles with scoped permissions (Admiral) ([#253](https://github.com/AnsoCode/Sencho/issues/253)) ([8380fba](https://github.com/AnsoCode/Sencho/commit/8380fbad4b617b004e2d2f19595d1490eaa1e005))
* **registries:** add private registry credential management (Admiral) ([#240](https://github.com/AnsoCode/Sencho/issues/240)) ([244c83a](https://github.com/AnsoCode/Sencho/commit/244c83a0c3102a797658d35d087bf47366f6df75))
* Remote Nodes Foundation ([457c997](https://github.com/AnsoCode/Sencho/commit/457c9976bc40e5e48f0415c6ca13f435d3713424))
* Remote Nodes foundation: nodes table, node registry service, node management API, Node Manager UI, active-node switcher, and Nodes settings tab ([02e1ebe](https://github.com/AnsoCode/Sencho/commit/02e1ebe1b66a75d24f967fefe3839b4ad7ec4cfc))
* Remote Nodes Security & Polish ([2373043](https://github.com/AnsoCode/Sencho/commit/23730430d747c23dc13cbb90ed07186240a1d0e0))
* Remote Nodes Wiring & SSH Adapters ([8a4f887](https://github.com/AnsoCode/Sencho/commit/8a4f8874dede12443129c1ab87a8c581513b5cf4))
* **resources:** add network management with create, inspect, and topology ([#338](https://github.com/AnsoCode/Sencho/issues/338)) ([24299a0](https://github.com/AnsoCode/Sencho/commit/24299a0115ce0371f44608f8d64248e6474df8ce))
* **resources:** add network management with create, inspect, and topology visualization ([#335](https://github.com/AnsoCode/Sencho/issues/335)) ([4488637](https://github.com/AnsoCode/Sencho/commit/4488637656b8a19f8df2fcea7ffafff023786068))
* **resources:** managed/unmanaged resource separation across Resources Hub ([2a444bd](https://github.com/AnsoCode/Sencho/commit/2a444bde99e13b2e94fa2476f463399840d0e3bf))
* **scheduled-ops:** add failure notifications, granular targeting, and history export ([#286](https://github.com/AnsoCode/Sencho/issues/286)) ([eccdd1b](https://github.com/AnsoCode/Sencho/commit/eccdd1b87903c17af822edb0cdb4236812929bd2))
* **scheduled-ops:** add scheduled operations for Admiral users ([#231](https://github.com/AnsoCode/Sencho/issues/231)) ([31e1795](https://github.com/AnsoCode/Sencho/commit/31e1795af06beaa68ec6e2240d83b7656ab549f7))
* **settings:** harden settings API and overhaul SettingsModal ([23a2259](https://github.com/AnsoCode/Sencho/commit/23a22598abb9185996b6180cb2c78f0311efd4c6))
* **settings:** replace static license CTA with dynamic upgrade cards ([#201](https://github.com/AnsoCode/Sencho/issues/201)) ([d3828e8](https://github.com/AnsoCode/Sencho/commit/d3828e885d78b23902a3a82186dcd009e3f2c0d9))
* **settings:** scope split: developer settings always target local node ([f7e8e40](https://github.com/AnsoCode/Sencho/commit/f7e8e409158e038404d4a531331b09d7c37f5113))
* SSO & LDAP authentication for Admiral ([#209](https://github.com/AnsoCode/Sencho/issues/209)) ([bd4008f](https://github.com/AnsoCode/Sencho/commit/bd4008f5091122f74967b4debdd4c4f046693f46))
* stack context menu, tier icons, centered logo & support ([#194](https://github.com/AnsoCode/Sencho/issues/194)) ([dda1671](https://github.com/AnsoCode/Sencho/commit/dda1671e5a4c6788ba5ad97b00cbac98910f3ef0))
* **stack-management:** add scan stacks folder button ([#332](https://github.com/AnsoCode/Sencho/issues/332)) ([6f74153](https://github.com/AnsoCode/Sencho/commit/6f7415351f648120ab4039f1fcc9a1226cfa52f4))
* **stacks:** per-stack action tracking, optimistic status, and bulk status endpoint ([#362](https://github.com/AnsoCode/Sencho/issues/362)) ([dfd4d28](https://github.com/AnsoCode/Sencho/commit/dfd4d2858a023ed013afbe93c077a3152a0773c5))
* **stacks:** state-aware sidebar context menu and Open App action ([#368](https://github.com/AnsoCode/Sencho/issues/368)) ([55d3b8c](https://github.com/AnsoCode/Sencho/commit/55d3b8ca1dea6958cecf9d1672a6d891751f7ae3))
* **system:** background image update checker with stack badges ([ef5621e](https://github.com/AnsoCode/Sencho/commit/ef5621e48457341719dc743045c0923178d3b280))
* UI polish sprint: 7 items + logs toolbar redesign ([#365](https://github.com/AnsoCode/Sencho/issues/365)) ([f9ebd1d](https://github.com/AnsoCode/Sencho/commit/f9ebd1d77c74434e641e2fc41f4f6d3de8cbeeee))
* **ui:** glassmorphism redesign with settings decomposition ([#274](https://github.com/AnsoCode/Sencho/issues/274)) ([7637091](https://github.com/AnsoCode/Sencho/commit/7637091e84838047c462e3dbce38122d4c24d007))
* **ui:** Phase 57 - Remote Context Navigation ([b7748b4](https://github.com/AnsoCode/Sencho/commit/b7748b4d170bb712db5f0851ed9cf2f9fa473f78))
* **ui:** Phase 57 - remote context UX (Option A) + network layer fixes ([04c770c](https://github.com/AnsoCode/Sencho/commit/04c770c198892618fa69713f47d3b8efbd44eab7))
* **ui:** redesign top bar with three-zone navigation layout ([#237](https://github.com/AnsoCode/Sencho/issues/237)) ([b7e7ee8](https://github.com/AnsoCode/Sencho/commit/b7e7ee8f55ec6bf89acc7bb54d47eab12ac940c5))
* **ui:** theme-aware sidebar logo with dark/light variants ([#74](https://github.com/AnsoCode/Sencho/issues/74)) ([b25574a](https://github.com/AnsoCode/Sencho/commit/b25574a427fcfabd69d13f7515e100fe652fbef7))
* Unified Observability ([935c2b0](https://github.com/AnsoCode/Sencho/commit/935c2b016a70d79a7c1249cd1ddbab0a6745d3f3))
* **webhooks:** add CI/CD webhook integration for triggering stack actions (Skipper and Admiral) ([#177](https://github.com/AnsoCode/Sencho/issues/177)) ([4fc3633](https://github.com/AnsoCode/Sencho/commit/4fc363301a1aaa442adbed83aebd21ca0e71c9c5))

### Fixed

* add --exclude='.git' to the rsync invocation. ([8902f6f](https://github.com/AnsoCode/Sencho/commit/8902f6fb4ccddb06f8dec7ef193fca817d2e686a))
* add linux/arm64 platform to Docker build for ARM server support ([12467c3](https://github.com/AnsoCode/Sencho/commit/12467c3fc1d19f43eb234802944300d7a36ccf56))
* add tls_ca, tls_cert, tls_key to frontend Node interface ([96b1105](https://github.com/AnsoCode/Sencho/commit/96b1105343402b888ddda98f76c0445b6b3aedf1))
* **alerts:** overhaul alerts & notifications system for local and remote nodes ([33c4976](https://github.com/AnsoCode/Sencho/commit/33c4976dc78832e0c8a53c92b1ad03ba01c44175))
* **api-tokens:** harden scope enforcement and add expiration support ([#224](https://github.com/AnsoCode/Sencho/issues/224)) ([954994c](https://github.com/AnsoCode/Sencho/commit/954994cdc01e5cee3e65153c2a302afed2da2b44))
* **api-tokens:** harden scope enforcement and block sensitive endpoints ([#228](https://github.com/AnsoCode/Sencho/issues/228)) ([5b607de](https://github.com/AnsoCode/Sencho/commit/5b607de227eecf4000208b347d8157f2d5d94651))
* App Store Polish & Rollbacks ([7935029](https://github.com/AnsoCode/Sencho/commit/7935029369e19ec1924e12979a5fcd7089fbe446))
* **backend,frontend:** correct docker socket connection on windows and fix api proxy in vite config ([4aa4bf1](https://github.com/AnsoCode/Sencho/commit/4aa4bf1b804bfee2046f17aea15cea1e96293db2))
* **backend:** remove broken remote branch in the system stats endpoint ([3f473c5](https://github.com/AnsoCode/Sencho/commit/3f473c5c97d3d914df898dc8b590b04c838b85ff))
* cast req.params.id as string to resolve TS2345 type errors ([d2c5b2d](https://github.com/AnsoCode/Sencho/commit/d2c5b2de6711351df5947ebd4004c1fbbc659628))
* **charts:** suppress Recharts dimension warnings on initial render ([#141](https://github.com/AnsoCode/Sencho/issues/141)) ([c6633b0](https://github.com/AnsoCode/Sencho/commit/c6633b0245d10671aac78fedac875be63c62a1e1))
* **ci:** add linux/arm64 Docker build support with QEMU optimization ([#76](https://github.com/AnsoCode/Sencho/issues/76)) ([278f7f1](https://github.com/AnsoCode/Sencho/commit/278f7f18d91ccae8afda48275e8e62b9c2b86d4f))
* **ci:** add load: true to buildx so Trivy can find the built image ([353fd25](https://github.com/AnsoCode/Sencho/commit/353fd253e93356720243f2ccde8b34a5801cfc10))
* **ci:** correct release-please changelog section names and tag format ([ea57cbe](https://github.com/AnsoCode/Sencho/commit/ea57cbe97f7f4166c747f3e3710f85e57ab476a1))
* **ci:** docker-publish tag trigger ([6cd84ba](https://github.com/AnsoCode/Sencho/commit/6cd84ba9c6b40f2a1630e783c49b397e6d6969dc))
* **ci:** docker-publish tag trigger + re-release v0.1.0 ([6cd84ba](https://github.com/AnsoCode/Sencho/commit/6cd84ba9c6b40f2a1630e783c49b397e6d6969dc))
* **ci:** exclude .git from rsync --delete in sync-docs ([aefeb7a](https://github.com/AnsoCode/Sencho/commit/aefeb7a35febb6fb33843f2c407fce70b40bcb56))
* **ci:** fix sync-docs empty-repo crash and update-screenshots protected-branch push ([bed63f8](https://github.com/AnsoCode/Sencho/commit/bed63f8b4725065988254c5d5113866033de38ac))
* **ci:** fix update-screenshots token and sync-docs empty-repo handling ([392a49e](https://github.com/AnsoCode/Sencho/commit/392a49e0bd27894249f918b6a918b0642ae7c41f))
* **ci:** release-please config corrections ([b6391b9](https://github.com/AnsoCode/Sencho/commit/b6391b96ffd4edf7a303350f7416ab1945136e1b))
* **ci:** trigger docker-publish on v* tag push instead of GitHub Release event ([c8047c2](https://github.com/AnsoCode/Sencho/commit/c8047c209cfb98fd56e7484b5db01f564aa6d027))
* **ci:** update lock files after adding ESLint deps and fixing high CVEs ([3cf9f02](https://github.com/AnsoCode/Sencho/commit/3cf9f023d3f5bc798bfbea5ffeebaee940dfe546))
* **ci:** use double-quoted string for if condition to fix YAML parse error ([f5c5eda](https://github.com/AnsoCode/Sencho/commit/f5c5eda30a65ba7fc4443a1a927f818e339c34f4))
* **ci:** YAML syntax error and sync-docs git directory failure ([dfa93c0](https://github.com/AnsoCode/Sencho/commit/dfa93c0bba9f3cbf684140b9a456359c6745a98f))
* **ci:** YAML syntax error in if condition and safe.directory for sync-docs ([dc79683](https://github.com/AnsoCode/Sencho/commit/dc79683b01690cfe16293660481aa5fdb030603d))
* **csp:** allow external images in App Store and suppress console warnings ([#138](https://github.com/AnsoCode/Sencho/issues/138)) ([c5217cd](https://github.com/AnsoCode/Sencho/commit/c5217cd96de3dd8d2971668373b6eabd2c1654a4))
* dashboard cards and stacks list do not update on remote node switch ([497a48c](https://github.com/AnsoCode/Sencho/commit/497a48c2ed1bc81f53533b49e30e975122d41b65))
* **dashboard:** correct stale Stats reset with inactive field ([0d5dc57](https://github.com/AnsoCode/Sencho/commit/0d5dc574a42e6550bf0e58cc5f60988a970201db))
* **dashboard:** surface server error messages in create-stack flow ([9367abf](https://github.com/AnsoCode/Sencho/commit/9367abf8d36fd6769b59f25dac01e7385eaf20c0))
* **db:** recreate stack_update_status table with composite primary key ([#356](https://github.com/AnsoCode/Sencho/issues/356)) ([4fe4ac5](https://github.com/AnsoCode/Sencho/commit/4fe4ac5d19cddc7db3d05563e8977d0c70d963f2))
* Distributed API Auth ([45a6420](https://github.com/AnsoCode/Sencho/commit/45a642014f10eb08a3cc69d5043194ecf4ca00e7))
* Distributed API auth hardening: Bearer tokens and URL normalization ([5932bce](https://github.com/AnsoCode/Sencho/commit/5932bced3660f285b8ec43636c49a93c45d02113))
* Distributed API Proxy & Auth Refinement ([9e6f721](https://github.com/AnsoCode/Sencho/commit/9e6f72111df97b11be7c8a7f62e062fe97881ab9))
* Distributed API proxy memory leak, node switcher refresh, and copy button ([fddd855](https://github.com/AnsoCode/Sencho/commit/fddd85562432e28de2ac879b804a5111eb802c96))
* Distributed API UI & Metrics Polish ([ebec4a5](https://github.com/AnsoCode/Sencho/commit/ebec4a5943bc27ded5ad14443b5da676e852fbf8))
* Distributed API UI & metrics polish + DEP0060 suppression ([eb0c026](https://github.com/AnsoCode/Sencho/commit/eb0c0263c7519ea40720fc992d87409fb01acdb6))
* **docker:** add entrypoint for volume permission handling ([593a709](https://github.com/AnsoCode/Sencho/commit/593a7091978a2024080ef1bbd394d86acb185b17))
* **docker:** entrypoint for volume permission handling ([c743f6c](https://github.com/AnsoCode/Sencho/commit/c743f6cd45ed8adf97e5bc49f88dbb4b69b41561))
* **docker:** fix xx cross-compilation sysroot for native modules ([#80](https://github.com/AnsoCode/Sencho/issues/80)) ([381701e](https://github.com/AnsoCode/Sencho/commit/381701ee258727b24031c09695c11bdf2cc7c854))
* **docker:** fix xx cross-compilation sysroot for node-pty and C++ modules ([518b0af](https://github.com/AnsoCode/Sencho/commit/518b0afb85023dbd32d7e90bdebaa139f9688d44))
* **docker:** install Docker CLI v29.3.1 from static binaries to resolve CVEs ([#268](https://github.com/AnsoCode/Sencho/issues/268)) ([f9b86e6](https://github.com/AnsoCode/Sencho/commit/f9b86e6f53e83ea0b5e8de7c1c916196d3345aee))
* **docker:** repair broken entrypoint from bad merge conflict resolution ([987fc3d](https://github.com/AnsoCode/Sencho/commit/987fc3d3396f7d66d5b847bb2700be5e87c20af4))
* **docker:** replace QEMU npm execution with tonistiigi/xx cross-compilation ([#78](https://github.com/AnsoCode/Sencho/issues/78)) ([1e0014e](https://github.com/AnsoCode/Sencho/commit/1e0014e1832653a0d8ce23182a2c2c7ef9efde2e))
* **docker:** upgrade Compose v2.40.3 → v5.1.1 to remediate dependency CVEs ([#283](https://github.com/AnsoCode/Sencho/issues/283)) ([36ebd5a](https://github.com/AnsoCode/Sencho/commit/36ebd5a9c1c82b5d7631d32831ac8ac420b0c782))
* **docker:** use native g++ for same-platform builds, xx-clang only for cross ([f23d8c6](https://github.com/AnsoCode/Sencho/commit/f23d8c660dc817f8e4486e656a38aadd9e6e5414))
* **e2e:** fill api_token in nodes tests so submit button is enabled ([707a5e8](https://github.com/AnsoCode/Sencho/commit/707a5e81c1865a45ee1789b7d43fa08eeb81b00b))
* **e2e:** fix stacks timeout and nodes skip in CI ([14c24c8](https://github.com/AnsoCode/Sencho/commit/14c24c82456cd8792cfb5d9f45d6c27b35dac32e))
* **e2e:** fully rewrite nodes tests to handle Radix UI Select and remote type flow ([12bbe51](https://github.com/AnsoCode/Sencho/commit/12bbe51a3af2ef8e48b5165b48026dd4566e9777))
* **e2e:** get all E2E tests passing and fix AlertDialog crash on delete ([f7471a1](https://github.com/AnsoCode/Sencho/commit/f7471a1a18f28c20e903b838ab4bcc8f8e0b73f8))
* **e2e:** use #node-name locator instead of getByLabel in nodes tests ([e01c0d6](https://github.com/AnsoCode/Sencho/commit/e01c0d6b4818c815897fd13b6ec319721a226b73))
* **e2e:** use button role for Resources nav item in screenshots spec ([b0e2b2d](https://github.com/AnsoCode/Sencho/commit/b0e2b2d025b86fca26b193f3eeda7e20c285da53))
* **e2e:** wait for sidebar stacks to finish loading before assertions ([#149](https://github.com/AnsoCode/Sencho/issues/149)) ([9ba9a3a](https://github.com/AnsoCode/Sencho/commit/9ba9a3a4565702135f22736a6b2310fc0da1d2f1))
* **editor:** bundle Monaco locally to fix stuck Loading state ([0eaa45b](https://github.com/AnsoCode/Sencho/commit/0eaa45bd7f5a4b5db9d51a577d25175bbcb4ff77))
* **editor:** bundle Monaco locally to fix stuck Loading state and CSP block ([79fde6e](https://github.com/AnsoCode/Sencho/commit/79fde6e2bd598085abfc7c702f5745bdfd692aec))
* **editor:** ESLint unused params fix ([dd5b698](https://github.com/AnsoCode/Sencho/commit/dd5b698b3f96e643af608a36128f05874a3b1f3c))
* **editor:** Monaco CSP fix + release pipeline fixes ([36a9bf3](https://github.com/AnsoCode/Sencho/commit/36a9bf3109c096ddd5d8095089a6ffb7bd6dee8d))
* **editor:** Monaco CSP fix + release pipeline fixes: v0.2.1 ([36a9bf3](https://github.com/AnsoCode/Sencho/commit/36a9bf3109c096ddd5d8095089a6ffb7bd6dee8d))
* **editor:** remove unused params from getWorker to satisfy ESLint ([34172a9](https://github.com/AnsoCode/Sencho/commit/34172a99226a4810465968ff9d238b85b1430829))
* **env:** resolve 404 when loading env files and CSP inline script violation ([#134](https://github.com/AnsoCode/Sencho/issues/134)) ([1e6367a](https://github.com/AnsoCode/Sencho/commit/1e6367a147dddb323799a3cd1947507c595d21db))
* **error-handling:** surface silent errors across the codebase ([#326](https://github.com/AnsoCode/Sencho/issues/326)) ([10597d2](https://github.com/AnsoCode/Sencho/commit/10597d213a5dfdc47dddd53998336fb09889962b))
* fix dashboard out of memory crash on remote nodes ([e027a94](https://github.com/AnsoCode/Sencho/commit/e027a94492a94a4370f578c189065404908f47ef))
* fix dashboard out of memory crashing from massive historical metrics payloads ([4e9777d](https://github.com/AnsoCode/Sencho/commit/4e9777d47fb8c1361cad0454c3bcdefc4cee645d))
* **fleet:** navigate to editor instead of dashboard on "Open in Editor" click ([#289](https://github.com/AnsoCode/Sencho/issues/289)) ([71ce6b3](https://github.com/AnsoCode/Sencho/commit/71ce6b3e1b6cb974d44279e503f9a158d027555a))
* **fleet:** resolve getSenchoVersion crash in Docker containers ([#391](https://github.com/AnsoCode/Sencho/issues/391)) ([d437a19](https://github.com/AnsoCode/Sencho/commit/d437a195b695f6cb60411db8dbf1f23f22e298db))
* **fleet:** resolve remote node capability detection failures ([#388](https://github.com/AnsoCode/Sencho/issues/388)) ([dee7c66](https://github.com/AnsoCode/Sencho/commit/dee7c6685b22b3daf9e57363564133f6d7f0639f))
* **frontend:** remove duplicate ScrollArea tag causing build failure ([d38d48f](https://github.com/AnsoCode/Sencho/commit/d38d48fafe8f2b332be3f0b8ef58712e15d3ce65))
* **frontend:** sync NodeContext with localStorage on initial load ([eb58f30](https://github.com/AnsoCode/Sencho/commit/eb58f302a1bafb7afd155a1a2ca31e874dc8e60d))
* gate SSO and Audit behind Admiral license tier ([#213](https://github.com/AnsoCode/Sencho/issues/213)) ([8d48b0a](https://github.com/AnsoCode/Sencho/commit/8d48b0abff08195a436f98bf8d42c45de51930df))
* Global Logs Polish ([f501fa4](https://github.com/AnsoCode/Sencho/commit/f501fa47128ac9a57591897c77ff87334325a5e8))
* Global Logs UX Polish ([7336ea8](https://github.com/AnsoCode/Sencho/commit/7336ea896e995b0a1aef0c9de95de94c9b9ecb4b))
* harden docker api validation, handle sftp errors, and fix node manager ui ([4bd80e2](https://github.com/AnsoCode/Sencho/commit/4bd80e29bf52f463a9024932a180b82e682f19f0))
* harden telemetry parsing and null node fallbacks ([f1f8e34](https://github.com/AnsoCode/Sencho/commit/f1f8e34da5fa9efe59dbe08b6ba5d136cfcb5be8))
* implement atomic deployment rollbacks and custom scrollbar UI ([6940825](https://github.com/AnsoCode/Sencho/commit/69408257d23803ba3fd1c8fd4a153d7a1a34df9e))
* implement smart auto-scroll and definitive stack filtering in global logs ([b267408](https://github.com/AnsoCode/Sencho/commit/b2674080c4a28888b5fbe98b085ec53c93f19aac))
* implement two-stage teardown for reliable atomic rollbacks ([c4805a1](https://github.com/AnsoCode/Sencho/commit/c4805a17ac2dff894e0db6df4605248098e77053))
* **license:** default 14-day trial to Skipper instead of Admiral ([#216](https://github.com/AnsoCode/Sencho/issues/216)) ([f99abe9](https://github.com/AnsoCode/Sencho/commit/f99abe907d5a39f4f32fb08bf25eda9b00dae88b))
* **licensing:** backward-compatible tier/variant enforcement and self-healing variant detection ([#385](https://github.com/AnsoCode/Sencho/issues/385)) ([9e0c9d3](https://github.com/AnsoCode/Sencho/commit/9e0c9d3f2d59f3330becc2153e2b638823c96b10))
* **licensing:** rename variant values to skipper/admiral and store resolved type ([#379](https://github.com/AnsoCode/Sencho/issues/379)) ([797623e](https://github.com/AnsoCode/Sencho/commit/797623e56fb97e6233f27fb9cc5be12613672707))
* **licensing:** resolve Admiral variant detection and lifetime license handling ([#376](https://github.com/AnsoCode/Sencho/issues/376)) ([f841c40](https://github.com/AnsoCode/Sencho/commit/f841c402b2e75874b066400adadcd8dcdfa9ac5f))
* **licensing:** resolve variant from product_name when variant_name lacks tier info ([#382](https://github.com/AnsoCode/Sencho/issues/382)) ([b08f698](https://github.com/AnsoCode/Sencho/commit/b08f698e8f1a2578bdecd274e923f63818239dd1))
* **lint:** resolve all backend ESLint errors to pass CI lint step ([e876a91](https://github.com/AnsoCode/Sencho/commit/e876a91a2e54267b82805731722f4a80ff2ad193))
* **lint:** resolve all ESLint errors to pass CI lint step ([c8a54a9](https://github.com/AnsoCode/Sencho/commit/c8a54a988bc86ea6a9acf05a116e571a735cd4a3))
* **logs:** cap DOM rendering to 300 rows to prevent browser OOM crash ([ec3a249](https://github.com/AnsoCode/Sencho/commit/ec3a2495a2cf71feb1bd8880a8a2ee1d2cc46c10))
* **logs:** cap DOM rendering to 300 rows to prevent OOM crash ([0db6c94](https://github.com/AnsoCode/Sencho/commit/0db6c946e7dcb38de84346fdd3d0f38450ee3eef))
* **logs:** use monotonic _id key to prevent O(n) DOM mutations on scroll ([753b0c3](https://github.com/AnsoCode/Sencho/commit/753b0c35399f0e564f40970328212ed06393e9d3))
* Memory Leak & Reload Loop ([ac5032d](https://github.com/AnsoCode/Sencho/commit/ac5032d3635614af682f7917a057467ea7b916d3))
* memory leak in SSE log accumulation and infinite reload loop in NodeContext ([fd07374](https://github.com/AnsoCode/Sencho/commit/fd073749563e993524c7d567886b10587f695f1a))
* **merge:** resolve CHANGELOG conflict with develop ([9f0257e](https://github.com/AnsoCode/Sencho/commit/9f0257e94fb6dddaa2287103e0f6bad7b3f3fac9))
* Observability Polish & Normalization ([da5a74a](https://github.com/AnsoCode/Sencho/commit/da5a74a4246fbe691c1a64b00d992bc96da5196f))
* Observability UI & TTY Parsing ([1f544c6](https://github.com/AnsoCode/Sencho/commit/1f544c656804443b221322091b8317aefabb549d))
* proxy forwards browser cookie to remote causing 401; fix node context self-heal loop ([7b2f28f](https://github.com/AnsoCode/Sencho/commit/7b2f28f505cd58c29baaff3f542bbdc7e4963dd2))
* **proxy:** prevent remote 401 from triggering local session logout ([278aa22](https://github.com/AnsoCode/Sencho/commit/278aa2298f2874cb5b86c5e38d6e550a792b689b))
* **proxy:** re-stream express.json()-consumed body to remote nodes for POST/PUT/PATCH ([a703707](https://github.com/AnsoCode/Sencho/commit/a703707aa0b5bd30cb6715c0371b6822ced353f3))
* **proxy:** skip express.json() for remote proxy requests to fix body forwarding ([ed69543](https://github.com/AnsoCode/Sencho/commit/ed6954307b82370fb8205f359eb412efaaf38d63))
* refine log level parsing and implement bottom auto-scroll ([9af0f85](https://github.com/AnsoCode/Sencho/commit/9af0f857498a7caf2b7e4b8c0faac649393c3bf5))
* remediate Dependabot and Docker Scout security vulnerabilities ([#265](https://github.com/AnsoCode/Sencho/issues/265)) ([59fd528](https://github.com/AnsoCode/Sencho/commit/59fd5285351c14f6e9cde073bd983de073fa3a75))
* remediate observability dashboard and global logs parsing ([29b1015](https://github.com/AnsoCode/Sencho/commit/29b10150b43103cdf0a234717b989df0c4660939))
* Remote Nodes Hardening ([7f23c88](https://github.com/AnsoCode/Sencho/commit/7f23c88c7393d82ef7ecfbc09dfd3427f31c4bf2))
* Remote Nodes Remediation: Port Routing, SSH Credentials & compose_dir ([1fb0494](https://github.com/AnsoCode/Sencho/commit/1fb0494e2e155847e83b3f14c4244727bc2fc7fa))
* Remote Nodes Telemetry Fixes ([792e977](https://github.com/AnsoCode/Sencho/commit/792e97709891d197bdc0ee01f4e8c40b4055de10))
* remote proxy strips /api prefix: remote Sencho returns SPA HTML instead of JSON ([efd3d7b](https://github.com/AnsoCode/Sencho/commit/efd3d7bd7f7104550e6a6f793b9a9c4e5b83b9ff))
* remote proxy strips /api prefix causing remote Sencho to return SPA HTML ([a26c255](https://github.com/AnsoCode/Sencho/commit/a26c255e7c2edfc6740f99aef879c9ec870ef420))
* **remote:** harden WS stream lifecycle, auth precedence, and proxy error handling ([1831411](https://github.com/AnsoCode/Sencho/commit/18314119b037b1adcbb16abc2d1e94e66b7168d5))
* **remote:** repair stats, bash exec, and Open App for remote nodes ([dbf8ec8](https://github.com/AnsoCode/Sencho/commit/dbf8ec8a2a0429dc58097cfaa63aa0e1b18cabb2))
* **remote:** strip cookie & nodeId from WS/HTTP proxy to remote nodes ([f115a48](https://github.com/AnsoCode/Sencho/commit/f115a48cfe995461db9a89ca5cb4c80d692a8f3c))
* **remote:** strip cookie header and nodeId from WS/HTTP proxy to remote nodes ([774190c](https://github.com/AnsoCode/Sencho/commit/774190cbb8363948b0a738c2174bd7e7b09177aa))
* remove unused React import in TemplatesView ([9c66a4f](https://github.com/AnsoCode/Sencho/commit/9c66a4f783d2463cc929080f8d8c3f98de61207c))
* replace naive log level detection with robust 3-tier regex class… ([c324d98](https://github.com/AnsoCode/Sencho/commit/c324d987ead2474ca5629a6fa75a3db0871b48e2))
* replace naive log level detection with robust 3-tier regex classification engine ([b7e6b5a](https://github.com/AnsoCode/Sencho/commit/b7e6b5a21c39c30995e5b3c22ce5fdb2950a7570))
* resolve a SQL syntax error in the database layer and add concrete file adapter implementations ([69e86a0](https://github.com/AnsoCode/Sencho/commit/69e86a0a37da11573bb4f5a72bbba16b4299452c))
* **scheduled-ops:** audit log text, run attribution, prune targets, and pagination ([#234](https://github.com/AnsoCode/Sencho/issues/234)) ([330eec4](https://github.com/AnsoCode/Sencho/commit/330eec4bff6f194aafdcbe499ab893bef06254b6))
* **security:** disable COOP header and Vite module-preload polyfill ([c36ee93](https://github.com/AnsoCode/Sencho/commit/c36ee9341630b3170c17a03d60bab90d387d09be))
* **security:** enforce stack name validation on all routes ([#314](https://github.com/AnsoCode/Sencho/issues/314)) ([1ab04be](https://github.com/AnsoCode/Sencho/commit/1ab04be235cc0d3020d17dfb3028e4679206b886))
* **security:** explicitly disable upgrade-insecure-requests via Helmet 8 API ([50df5b3](https://github.com/AnsoCode/Sencho/commit/50df5b3c028cc7dea75f93b994a6feb908988849))
* **security:** harden encryption key permissions, increase password minimum, remove sensitive logs ([#323](https://github.com/AnsoCode/Sencho/issues/323)) ([f317a83](https://github.com/AnsoCode/Sencho/commit/f317a83814fda3a98eb009c1a05a955bfadd6f0d))
* **security:** pre-launch security hardening audit & remediation ([#320](https://github.com/AnsoCode/Sencho/issues/320)) ([2d6b4c2](https://github.com/AnsoCode/Sencho/commit/2d6b4c233daa178de485dfeb198fc90376949ca4))
* **security:** prevent path traversal via env_file resolution ([#311](https://github.com/AnsoCode/Sencho/issues/311)) ([dc545dd](https://github.com/AnsoCode/Sencho/commit/dc545dd61337904e26e18e5e5bed190675432406))
* **security:** remove CSP upgrade-insecure-requests and HSTS for HTTP deployments ([25012a0](https://github.com/AnsoCode/Sencho/commit/25012a07caa7b545cbdbbdb033778cccc42a618c))
* **security:** remove CSP upgrade-insecure-requests and HSTS over HTTP ([cf2946c](https://github.com/AnsoCode/Sencho/commit/cf2946cfa67157db716e15544fdd547945ec0c3e))
* separate Docker API port from SSH port, add SSH credential UI, fix compose_dir routing ([26b8f62](https://github.com/AnsoCode/Sencho/commit/26b8f629685867b3c1ff98d6c02b1a089087b3b6))
* **settings:** prevent X button overlap and add tooltip to Always Local badge ([ed0817b](https://github.com/AnsoCode/Sencho/commit/ed0817b2c59187b3a1ac9dc52a9ce6ec6e3427bd))
* skip remote nodes in the local monitoring loop ([880919f](https://github.com/AnsoCode/Sencho/commit/880919fb7835ad37c79949e8c923cd3cf351d7b3))
* skip remote nodes in the local monitoring loop to prevent direct Docker access errors ([b48cf62](https://github.com/AnsoCode/Sencho/commit/b48cf62e5b1c3eef35c01da381f2c0528e0cf2fa))
* **stacks:** avoid resource busy error in Docker fallback deletion ([#271](https://github.com/AnsoCode/Sencho/issues/271)) ([10d1636](https://github.com/AnsoCode/Sencho/commit/10d16361fae2869367a9f757bfc0ab4c3e04ca2c))
* **stacks:** resolve permission denied error on stack deletion ([#261](https://github.com/AnsoCode/Sencho/issues/261)) ([116f15d](https://github.com/AnsoCode/Sencho/commit/116f15dae9c3b530145316ea8b2954ed478fed76))
* **stats:** classify managed containers by working_dir instead of project name ([16e978b](https://github.com/AnsoCode/Sencho/commit/16e978bf4e360f59b3f79b7a38194509fcaddda2))
* **stats:** throttle container stat WebSocket updates via ref buffer ([74964b0](https://github.com/AnsoCode/Sencho/commit/74964b0e264f856bb3f8204496a57f48bfbbbe7e))
* stop infinite page reload caused by premature NodeProvider mount and 401 hard-redirect ([67c7078](https://github.com/AnsoCode/Sencho/commit/67c7078128560a7823c6a190ce90ea5b3278a455))
* strip browser cookie from proxy requests; fix node context self-heal loop ([39e63be](https://github.com/AnsoCode/Sencho/commit/39e63bea8e66e404bae4a8420bc2f04d6602e09f))
* trigger docs sync on develop instead of main ([7d1b996](https://github.com/AnsoCode/Sencho/commit/7d1b996bb7c10d33330ed645c8cfd1fc302a93e0))
* **ts:** remove unused motion import from alert-dialog ([0dd72b3](https://github.com/AnsoCode/Sencho/commit/0dd72b3eb467598452938133f563042df15c8596))
* **ts:** use type-only import for Node to satisfy verbatimModuleSyntax ([94d6c8f](https://github.com/AnsoCode/Sencho/commit/94d6c8fc0f8f3afce0e95d80f6a75a3884cca2af))
* tty parsing, timezone mapping, and floating action bar for global logs ([8203dd6](https://github.com/AnsoCode/Sencho/commit/8203dd6a1464553c451cb93bd4725128616d3f80))
* **ui:** resolve 9 animated design system bugs including Monaco tab height accumulation ([22e6462](https://github.com/AnsoCode/Sencho/commit/22e646286e9321e66101f9aedc89a99edce1d3c4))
* **ui:** settings modal sidebar nav clipped on smaller viewports ([#280](https://github.com/AnsoCode/Sencho/issues/280)) ([9e14ce9](https://github.com/AnsoCode/Sencho/commit/9e14ce999f89052b218d2e3f974644f41355955c))
* update lsio template registry url to valid endpoint ([e45915f](https://github.com/AnsoCode/Sencho/commit/e45915f014668bcc97550b2eb3043f5ac6dbd392))
* **ws:** fix remote node console: delegate console session tokens ([6c518ce](https://github.com/AnsoCode/Sencho/commit/6c518cee5a8735dea3f06cc662706b900c8d93f1))
* **ws:** fix remote node console by delegating console session tokens ([30fe77c](https://github.com/AnsoCode/Sencho/commit/30fe77cd5d57b1dbae6a8b40aebf4f14453d571c))

### Security

* harden terminal WebSocket endpoints against three attack vectors ([2e0f3e2](https://github.com/AnsoCode/Sencho/commit/2e0f3e2711e02c2350342e1fdb56878a81658e38))
* pre-release hardening, automated testing, and production readiness ([ce50db0](https://github.com/AnsoCode/Sencho/commit/ce50db0fdee160e20b658f98b5d8fee86215afc3))

## [0.38.6](https://github.com/AnsoCode/Sencho/compare/v0.38.5...v0.38.6) (2026-04-06)

### Fixed

* **fleet:** resolve getSenchoVersion crash in Docker containers ([#391](https://github.com/AnsoCode/Sencho/issues/391)) ([d437a19](https://github.com/AnsoCode/Sencho/commit/d437a195b695f6cb60411db8dbf1f23f22e298db))

## [0.38.5](https://github.com/AnsoCode/Sencho/compare/v0.38.4...v0.38.5) (2026-04-06)

### Fixed

* **fleet:** resolve remote node capability detection failures ([#388](https://github.com/AnsoCode/Sencho/issues/388)) ([dee7c66](https://github.com/AnsoCode/Sencho/commit/dee7c6685b22b3daf9e57363564133f6d7f0639f))

## [0.38.4](https://github.com/AnsoCode/Sencho/compare/v0.38.3...v0.38.4) (2026-04-06)

### Fixed

* **licensing:** backward-compatible tier/variant enforcement and self-healing variant detection ([#385](https://github.com/AnsoCode/Sencho/issues/385)) ([9e0c9d3](https://github.com/AnsoCode/Sencho/commit/9e0c9d3f2d59f3330becc2153e2b638823c96b10))

## [0.38.3](https://github.com/AnsoCode/Sencho/compare/v0.38.2...v0.38.3) (2026-04-05)

### Fixed

* **licensing:** resolve variant from product_name when variant_name lacks tier info ([#382](https://github.com/AnsoCode/Sencho/issues/382)) ([b08f698](https://github.com/AnsoCode/Sencho/commit/b08f698e8f1a2578bdecd274e923f63818239dd1))

## [0.38.2](https://github.com/AnsoCode/Sencho/compare/v0.38.1...v0.38.2) (2026-04-05)

### Fixed

* **licensing:** rename variant values to skipper/admiral and store resolved type ([#379](https://github.com/AnsoCode/Sencho/issues/379)) ([797623e](https://github.com/AnsoCode/Sencho/commit/797623e56fb97e6233f27fb9cc5be12613672707))

## [0.38.1](https://github.com/AnsoCode/Sencho/compare/v0.38.0...v0.38.1) (2026-04-05)

### Fixed

* **licensing:** resolve Admiral variant detection and lifetime license handling ([#376](https://github.com/AnsoCode/Sencho/issues/376)) ([f841c40](https://github.com/AnsoCode/Sencho/commit/f841c402b2e75874b066400adadcd8dcdfa9ac5f))

## [0.38.0](https://github.com/AnsoCode/Sencho/compare/v0.37.0...v0.38.0) (2026-04-04)

### Added

* **dashboard:** redesign as DevOps command center ([#371](https://github.com/AnsoCode/Sencho/issues/371)) ([2ee959e](https://github.com/AnsoCode/Sencho/commit/2ee959ec3b696c5beba7b8b62bec2221ca65d525))

## [0.37.0](https://github.com/AnsoCode/Sencho/compare/v0.36.0...v0.37.0) (2026-04-04)

### Added

* **stacks:** state-aware sidebar context menu and Open App action ([#368](https://github.com/AnsoCode/Sencho/issues/368)) ([55d3b8c](https://github.com/AnsoCode/Sencho/commit/55d3b8ca1dea6958cecf9d1672a6d891751f7ae3))

## [0.36.0](https://github.com/AnsoCode/Sencho/compare/v0.35.0...v0.36.0) (2026-04-04)

### Added

* UI polish sprint: 7 items + logs toolbar redesign ([#365](https://github.com/AnsoCode/Sencho/issues/365)) ([f9ebd1d](https://github.com/AnsoCode/Sencho/commit/f9ebd1d77c74434e641e2fc41f4f6d3de8cbeeee))

## [0.35.0](https://github.com/AnsoCode/Sencho/compare/v0.34.0...v0.35.0) (2026-04-03)

### Added

* **stacks:** per-stack action tracking, optimistic status, and bulk status endpoint ([#362](https://github.com/AnsoCode/Sencho/issues/362)) ([dfd4d28](https://github.com/AnsoCode/Sencho/commit/dfd4d2858a023ed013afbe93c077a3152a0773c5))

## [0.34.0](https://github.com/AnsoCode/Sencho/compare/v0.33.1...v0.34.0) (2026-04-03)

### Added

* **license:** distributed license enforcement across multi-node setups ([#359](https://github.com/AnsoCode/Sencho/issues/359)) ([6c26ae3](https://github.com/AnsoCode/Sencho/commit/6c26ae3f501d438dcde5331bae588ee6e26c2c3e))

## [0.33.1](https://github.com/AnsoCode/Sencho/compare/v0.33.0...v0.33.1) (2026-04-03)

### Fixed

* **db:** recreate stack_update_status table with composite primary key ([#356](https://github.com/AnsoCode/Sencho/issues/356)) ([4fe4ac5](https://github.com/AnsoCode/Sencho/commit/4fe4ac5d19cddc7db3d05563e8977d0c70d963f2))

## [0.33.0](https://github.com/AnsoCode/Sencho/compare/v0.32.0...v0.33.0) (2026-04-03)

### Added

* **fleet:** add remote node update management ([#353](https://github.com/AnsoCode/Sencho/issues/353)) ([87b5908](https://github.com/AnsoCode/Sencho/commit/87b59082887902af24ad2bf88ae3d4d4c941411e))

## [0.32.0](https://github.com/AnsoCode/Sencho/compare/v0.31.0...v0.32.0) (2026-04-03)

### Added

* **nodes:** add capability-based node compatibility negotiation ([#350](https://github.com/AnsoCode/Sencho/issues/350)) ([ee75811](https://github.com/AnsoCode/Sencho/commit/ee75811e255e8d5f9ae87117d12c2902185d98f1))

## [0.31.0](https://github.com/AnsoCode/Sencho/compare/v0.30.0...v0.31.0) (2026-04-03)

### Added

* **notifications:** add shared notification routing rules (Admiral tier) ([#347](https://github.com/AnsoCode/Sencho/issues/347)) ([1b573f5](https://github.com/AnsoCode/Sencho/commit/1b573f542a36cde3e94c05f285d34330df96edb1))

## [0.30.0](https://github.com/AnsoCode/Sencho/compare/v0.29.0...v0.30.0) (2026-04-03)

### Added

* **nodes:** add per-node scheduling and update visibility ([#344](https://github.com/AnsoCode/Sencho/issues/344)) ([efbd20f](https://github.com/AnsoCode/Sencho/commit/efbd20fed57299acae43ecaee3b1d9ff52da5aae))

## [0.29.0](https://github.com/AnsoCode/Sencho/compare/v0.28.0...v0.29.0) (2026-04-02)

### Added

* **labels:** add stack labels for organizing, filtering, and bulk actions ([#341](https://github.com/AnsoCode/Sencho/issues/341)) ([28e7be6](https://github.com/AnsoCode/Sencho/commit/28e7be652cb18abdd51ca6df8eda2104d213dc30))

## [0.28.0](https://github.com/AnsoCode/Sencho/compare/v0.27.0...v0.28.0) (2026-04-02)

### Added

* **resources:** add network management with create, inspect, and topology ([#338](https://github.com/AnsoCode/Sencho/issues/338)) ([24299a0](https://github.com/AnsoCode/Sencho/commit/24299a0115ce0371f44608f8d64248e6474df8ce))

## [0.27.0](https://github.com/AnsoCode/Sencho/compare/v0.26.0...v0.27.0) (2026-04-02)

### Added

* **resources:** add network management with create, inspect, and topology visualization ([#335](https://github.com/AnsoCode/Sencho/issues/335)) ([4488637](https://github.com/AnsoCode/Sencho/commit/4488637656b8a19f8df2fcea7ffafff023786068))

## [0.26.0](https://github.com/AnsoCode/Sencho/compare/v0.25.3...v0.26.0) (2026-04-02)

### Added

* **stack-management:** add scan stacks folder button ([#332](https://github.com/AnsoCode/Sencho/issues/332)) ([6f74153](https://github.com/AnsoCode/Sencho/commit/6f7415351f648120ab4039f1fcc9a1226cfa52f4))

## [0.25.3](https://github.com/AnsoCode/Sencho/compare/v0.25.2...v0.25.3) (2026-04-02)

### Fixed

* **error-handling:** surface silent errors across the codebase ([#326](https://github.com/AnsoCode/Sencho/issues/326)) ([10597d2](https://github.com/AnsoCode/Sencho/commit/10597d213a5dfdc47dddd53998336fb09889962b))

## [0.25.2](https://github.com/AnsoCode/Sencho/compare/v0.25.1...v0.25.2) (2026-04-02)

### Fixed

* **security:** harden encryption key permissions, increase password minimum, remove sensitive logs ([#323](https://github.com/AnsoCode/Sencho/issues/323)) ([f317a83](https://github.com/AnsoCode/Sencho/commit/f317a83814fda3a98eb009c1a05a955bfadd6f0d))

## [0.25.1](https://github.com/AnsoCode/Sencho/compare/v0.25.0...v0.25.1) (2026-04-02)

### Fixed

* **security:** pre-launch security hardening audit & remediation ([#320](https://github.com/AnsoCode/Sencho/issues/320)) ([2d6b4c2](https://github.com/AnsoCode/Sencho/commit/2d6b4c233daa178de485dfeb198fc90376949ca4))

## [0.25.0](https://github.com/AnsoCode/Sencho/compare/v0.24.2...v0.25.0) (2026-04-02)

### Added

* **api:** add global rate limiter for all API endpoints ([#317](https://github.com/AnsoCode/Sencho/issues/317)) ([b28ebfa](https://github.com/AnsoCode/Sencho/commit/b28ebfa6ffff7fa76657c67e5fdb3494a76bd8a1))

## [0.24.2](https://github.com/AnsoCode/Sencho/compare/v0.24.1...v0.24.2) (2026-04-01)

### Fixed

* **security:** enforce stack name validation on all routes ([#314](https://github.com/AnsoCode/Sencho/issues/314)) ([1ab04be](https://github.com/AnsoCode/Sencho/commit/1ab04be235cc0d3020d17dfb3028e4679206b886))

## [0.24.1](https://github.com/AnsoCode/Sencho/compare/v0.24.0...v0.24.1) (2026-04-01)

### Fixed

* **security:** prevent path traversal via env_file resolution ([#311](https://github.com/AnsoCode/Sencho/issues/311)) ([dc545dd](https://github.com/AnsoCode/Sencho/commit/dc545dd61337904e26e18e5e5bed190675432406))

## [0.24.0](https://github.com/AnsoCode/Sencho/compare/v0.23.0...v0.24.0) (2026-04-01)

### Added

* **auto-update:** add auto-update policies and fix image update detection ([#297](https://github.com/AnsoCode/Sencho/issues/297)) ([28c7a8f](https://github.com/AnsoCode/Sencho/commit/28c7a8fd544f33ea0fbe90f19ed96154743eb527))

## [0.23.0](https://github.com/AnsoCode/Sencho/compare/v0.22.1...v0.23.0) (2026-03-31)

### Added

* **multi-node:** warn when configuring remote node with plain HTTP URL ([#292](https://github.com/AnsoCode/Sencho/issues/292)) ([e587256](https://github.com/AnsoCode/Sencho/commit/e587256086997a784007a69d8a7fd56881d0a9b1))

## [0.22.1](https://github.com/AnsoCode/Sencho/compare/v0.22.0...v0.22.1) (2026-03-31)

### Fixed

* **fleet:** navigate to editor instead of dashboard on "Open in Editor" click ([#289](https://github.com/AnsoCode/Sencho/issues/289)) ([71ce6b3](https://github.com/AnsoCode/Sencho/commit/71ce6b3e1b6cb974d44279e503f9a158d027555a))

## [0.22.0](https://github.com/AnsoCode/Sencho/compare/v0.21.2...v0.22.0) (2026-03-31)

### Added

* **scheduled-ops:** add failure notifications, granular targeting, and history export ([#286](https://github.com/AnsoCode/Sencho/issues/286)) ([eccdd1b](https://github.com/AnsoCode/Sencho/commit/eccdd1b87903c17af822edb0cdb4236812929bd2))

## [0.21.2](https://github.com/AnsoCode/Sencho/compare/v0.21.1...v0.21.2) (2026-03-30)

### Fixed

* **docker:** upgrade Compose v2.40.3 → v5.1.1 to remediate dependency CVEs ([#283](https://github.com/AnsoCode/Sencho/issues/283)) ([36ebd5a](https://github.com/AnsoCode/Sencho/commit/36ebd5a9c1c82b5d7631d32831ac8ac420b0c782))

## [0.21.1](https://github.com/AnsoCode/Sencho/compare/v0.21.0...v0.21.1) (2026-03-30)

### Fixed

* **ui:** settings modal sidebar nav clipped on smaller viewports ([#280](https://github.com/AnsoCode/Sencho/issues/280)) ([9e14ce9](https://github.com/AnsoCode/Sencho/commit/9e14ce999f89052b218d2e3f974644f41355955c))

## [0.21.0](https://github.com/AnsoCode/Sencho/compare/v0.20.0...v0.21.0) (2026-03-30)

### Added

* **host-console:** gate Host Console behind Admiral tier ([#277](https://github.com/AnsoCode/Sencho/issues/277)) ([b5d3f49](https://github.com/AnsoCode/Sencho/commit/b5d3f497cb1a09fdc2107f4ef720ebb7f07cbd87))

## [0.20.0](https://github.com/AnsoCode/Sencho/compare/v0.19.4...v0.20.0) (2026-03-30)

### Added

* **ui:** glassmorphism redesign with settings decomposition ([#274](https://github.com/AnsoCode/Sencho/issues/274)) ([7637091](https://github.com/AnsoCode/Sencho/commit/7637091e84838047c462e3dbce38122d4c24d007))

## [0.19.4](https://github.com/AnsoCode/Sencho/compare/v0.19.3...v0.19.4) (2026-03-30)

### Fixed

* **stacks:** avoid resource busy error in Docker fallback deletion ([#271](https://github.com/AnsoCode/Sencho/issues/271)) ([10d1636](https://github.com/AnsoCode/Sencho/commit/10d16361fae2869367a9f757bfc0ab4c3e04ca2c))

## [0.19.3](https://github.com/AnsoCode/Sencho/compare/v0.19.2...v0.19.3) (2026-03-30)

### Fixed

* **docker:** install Docker CLI v29.3.1 from static binaries to resolve CVEs ([#268](https://github.com/AnsoCode/Sencho/issues/268)) ([f9b86e6](https://github.com/AnsoCode/Sencho/commit/f9b86e6f53e83ea0b5e8de7c1c916196d3345aee))

## [0.19.2](https://github.com/AnsoCode/Sencho/compare/v0.19.1...v0.19.2) (2026-03-30)

### Fixed

* remediate Dependabot and Docker Scout security vulnerabilities ([#265](https://github.com/AnsoCode/Sencho/issues/265)) ([59fd528](https://github.com/AnsoCode/Sencho/commit/59fd5285351c14f6e9cde073bd983de073fa3a75))

## [0.19.1](https://github.com/AnsoCode/Sencho/compare/v0.19.0...v0.19.1) (2026-03-30)

### Fixed

* **stacks:** resolve permission denied error on stack deletion ([#261](https://github.com/AnsoCode/Sencho/issues/261)) ([116f15d](https://github.com/AnsoCode/Sencho/commit/116f15dae9c3b530145316ea8b2954ed478fed76))

## [0.19.0](https://github.com/AnsoCode/Sencho/compare/v0.18.0...v0.19.0) (2026-03-30)

### Added

* **audit-log:** add configurable retention, export, Auditor role, and enhanced filtering ([#258](https://github.com/AnsoCode/Sencho/issues/258)) ([d586ce3](https://github.com/AnsoCode/Sencho/commit/d586ce393af34c8cc34cd046d2d90a70e0d79964))

## [0.18.0](https://github.com/AnsoCode/Sencho/compare/v0.17.0...v0.18.0) (2026-03-29)

### Added

* **rbac:** add Deployer & Node Admin roles with scoped permissions (Admiral) ([#253](https://github.com/AnsoCode/Sencho/issues/253)) ([8380fba](https://github.com/AnsoCode/Sencho/commit/8380fbad4b617b004e2d2f19595d1490eaa1e005))

## [0.17.0](https://github.com/AnsoCode/Sencho/compare/v0.16.0...v0.17.0) (2026-03-29)

### Added

* **registries:** add private registry credential management (Admiral) ([#240](https://github.com/AnsoCode/Sencho/issues/240)) ([244c83a](https://github.com/AnsoCode/Sencho/commit/244c83a0c3102a797658d35d087bf47366f6df75))

## [0.16.0](https://github.com/AnsoCode/Sencho/compare/v0.15.1...v0.16.0) (2026-03-29)

### Added

* **ui:** redesign top bar with three-zone navigation layout ([#237](https://github.com/AnsoCode/Sencho/issues/237)) ([b7e7ee8](https://github.com/AnsoCode/Sencho/commit/b7e7ee8f55ec6bf89acc7bb54d47eab12ac940c5))

## [0.15.1](https://github.com/AnsoCode/Sencho/compare/v0.15.0...v0.15.1) (2026-03-29)

### Fixed

* **scheduled-ops:** audit log text, run attribution, prune targets, and pagination ([#234](https://github.com/AnsoCode/Sencho/issues/234)) ([330eec4](https://github.com/AnsoCode/Sencho/commit/330eec4bff6f194aafdcbe499ab893bef06254b6))

## [0.15.0](https://github.com/AnsoCode/Sencho/compare/v0.14.2...v0.15.0) (2026-03-29)

### Added

* **scheduled-ops:** add scheduled operations for Admiral users ([#231](https://github.com/AnsoCode/Sencho/issues/231)) ([31e1795](https://github.com/AnsoCode/Sencho/commit/31e1795af06beaa68ec6e2240d83b7656ab549f7))

## [0.14.2](https://github.com/AnsoCode/Sencho/compare/v0.14.1...v0.14.2) (2026-03-29)

### Fixed

* **api-tokens:** harden scope enforcement and block sensitive endpoints ([#228](https://github.com/AnsoCode/Sencho/issues/228)) ([5b607de](https://github.com/AnsoCode/Sencho/commit/5b607de227eecf4000208b347d8157f2d5d94651))

## [0.14.1](https://github.com/AnsoCode/Sencho/compare/v0.14.0...v0.14.1) (2026-03-28)

### Fixed

* **api-tokens:** harden scope enforcement and add expiration support ([#224](https://github.com/AnsoCode/Sencho/issues/224)) ([954994c](https://github.com/AnsoCode/Sencho/commit/954994cdc01e5cee3e65153c2a302afed2da2b44))

## [0.14.0](https://github.com/AnsoCode/Sencho/compare/v0.13.2...v0.14.0) (2026-03-28)

### Added

* **api-tokens:** add scoped API tokens for CI/CD automation (Admiral) ([#220](https://github.com/AnsoCode/Sencho/issues/220)) ([8d8118c](https://github.com/AnsoCode/Sencho/commit/8d8118c963a1c3b10872041ea0f645d8f0a65196))

## [0.13.2](https://github.com/AnsoCode/Sencho/compare/v0.13.1...v0.13.2) (2026-03-28)

### Fixed

* **license:** default 14-day trial to Skipper instead of Admiral ([#216](https://github.com/AnsoCode/Sencho/issues/216)) ([f99abe9](https://github.com/AnsoCode/Sencho/commit/f99abe907d5a39f4f32fb08bf25eda9b00dae88b))

## [0.13.1](https://github.com/AnsoCode/Sencho/compare/v0.13.0...v0.13.1) (2026-03-28)

### Fixed

* gate SSO and Audit behind Admiral license tier ([#213](https://github.com/AnsoCode/Sencho/issues/213)) ([8d48b0a](https://github.com/AnsoCode/Sencho/commit/8d48b0abff08195a436f98bf8d42c45de51930df))

## [0.13.0](https://github.com/AnsoCode/Sencho/compare/v0.12.0...v0.13.0) (2026-03-28)

### Added

* SSO & LDAP authentication for Admiral ([#209](https://github.com/AnsoCode/Sencho/issues/209)) ([bd4008f](https://github.com/AnsoCode/Sencho/commit/bd4008f5091122f74967b4debdd4c4f046693f46))

## [0.12.0](https://github.com/AnsoCode/Sencho/compare/v0.11.0...v0.12.0) (2026-03-28)

### Added

* audit logging, secrets at rest, and legacy cleanup ([#205](https://github.com/AnsoCode/Sencho/issues/205)) ([1799030](https://github.com/AnsoCode/Sencho/commit/179903006035280d5c1655daaf3dbe3384588bf0))

## [0.11.0](https://github.com/AnsoCode/Sencho/compare/v0.10.0...v0.11.0) (2026-03-28)

### Added

* **settings:** replace static license CTA with dynamic upgrade cards ([#201](https://github.com/AnsoCode/Sencho/issues/201)) ([d3828e8](https://github.com/AnsoCode/Sencho/commit/d3828e885d78b23902a3a82186dcd009e3f2c0d9))

## [0.10.0](https://github.com/AnsoCode/Sencho/compare/v0.9.0...v0.10.0) (2026-03-27)

### Added

* stack context menu, tier icons, centered logo & support ([#194](https://github.com/AnsoCode/Sencho/issues/194)) ([dda1671](https://github.com/AnsoCode/Sencho/commit/dda1671e5a4c6788ba5ad97b00cbac98910f3ef0))

## [0.9.0](https://github.com/AnsoCode/Sencho/compare/v0.8.0...v0.9.0) (2026-03-27)

### Added

* RBAC, atomic deployments, fleet backups, and licensing (Skipper and Admiral) ([#185](https://github.com/AnsoCode/Sencho/issues/185)) ([32a7d53](https://github.com/AnsoCode/Sencho/commit/32a7d53b2b1b9b3d2a067433c9e77709ade96697))

## [0.8.0](https://github.com/AnsoCode/Sencho/compare/v0.7.0...v0.8.0) (2026-03-26)

### Added

* RBAC, atomic deployments, and fleet-wide backups (Skipper and Admiral) ([#181](https://github.com/AnsoCode/Sencho/issues/181)) ([db73d76](https://github.com/AnsoCode/Sencho/commit/db73d7671a22b72756a16594004d9767970d4190))

## [0.7.0](https://github.com/AnsoCode/Sencho/compare/v0.6.0...v0.7.0) (2026-03-26)

### Added

* **webhooks:** add CI/CD webhook integration for triggering stack actions (Skipper and Admiral) ([#177](https://github.com/AnsoCode/Sencho/issues/177)) ([4fc3633](https://github.com/AnsoCode/Sencho/commit/4fc363301a1aaa442adbed83aebd21ca0e71c9c5))

## [0.6.0](https://github.com/AnsoCode/Sencho/compare/v0.5.0...v0.6.0) (2026-03-26)

### Added

* **fleet:** add Pro fleet management features and container drill-down ([#174](https://github.com/AnsoCode/Sencho/issues/174)) ([0630f57](https://github.com/AnsoCode/Sencho/commit/0630f57ca87451352e7c50d511522ac621771458))

## [0.5.0](https://github.com/AnsoCode/Sencho/compare/v0.4.0...v0.5.0) (2026-03-25)

### Added

* **auth:** redesign Login and Setup pages with split-panel branding layout ([#168](https://github.com/AnsoCode/Sencho/issues/168)) ([f80190d](https://github.com/AnsoCode/Sencho/commit/f80190d926c1d768ee1282861dffc7d272f06e21))

## [0.4.0](https://github.com/AnsoCode/Sencho/compare/v0.3.1...v0.4.0) (2026-03-25)

### Added

* **auth:** redesign Login and Setup pages with split-panel branding layout ([#153](https://github.com/AnsoCode/Sencho/issues/153)) ([e0319b5](https://github.com/AnsoCode/Sencho/commit/e0319b5daebbae88b942ba55f6891ce0e2ecaf29))

## [0.3.1](https://github.com/AnsoCode/Sencho/compare/v0.3.0...v0.3.1) (2026-03-25)

### Fixed

* **e2e:** wait for sidebar stacks to finish loading before assertions ([#149](https://github.com/AnsoCode/Sencho/issues/149)) ([9ba9a3a](https://github.com/AnsoCode/Sencho/commit/9ba9a3a4565702135f22736a6b2310fc0da1d2f1))

## [0.3.0](https://github.com/AnsoCode/Sencho/compare/v0.2.5...v0.3.0) (2026-03-25)

### Added

* add Community/Pro licensing, fleet view, and UI reorganization ([#145](https://github.com/AnsoCode/Sencho/issues/145)) ([4f26f22](https://github.com/AnsoCode/Sencho/commit/4f26f22ccef89441be032a266723cf6fca0a488a))

## [0.2.5](https://github.com/AnsoCode/Sencho/compare/v0.2.4...v0.2.5) (2026-03-25)

### Fixed

* **charts:** suppress Recharts dimension warnings on initial render ([#141](https://github.com/AnsoCode/Sencho/issues/141)) ([c6633b0](https://github.com/AnsoCode/Sencho/commit/c6633b0245d10671aac78fedac875be63c62a1e1))

## [0.2.4](https://github.com/AnsoCode/Sencho/compare/v0.2.3...v0.2.4) (2026-03-25)

### Fixed

* **csp:** allow external images in App Store and suppress console warnings ([#138](https://github.com/AnsoCode/Sencho/issues/138)) ([c5217cd](https://github.com/AnsoCode/Sencho/commit/c5217cd96de3dd8d2971668373b6eabd2c1654a4))

## [0.2.3](https://github.com/AnsoCode/Sencho/compare/v0.2.2...v0.2.3) (2026-03-25)

### Fixed

* **env:** resolve 404 when loading env files and CSP inline script violation ([#134](https://github.com/AnsoCode/Sencho/issues/134)) ([1e6367a](https://github.com/AnsoCode/Sencho/commit/1e6367a147dddb323799a3cd1947507c595d21db))

## [0.2.2](https://github.com/AnsoCode/Sencho/compare/v0.2.1...v0.2.2) (2026-03-25)

### Fixed

* **editor:** ESLint unused params fix ([dd5b698](https://github.com/AnsoCode/Sencho/commit/dd5b698b3f96e643af608a36128f05874a3b1f3c))
* **editor:** remove unused params from getWorker to satisfy ESLint ([34172a9](https://github.com/AnsoCode/Sencho/commit/34172a99226a4810465968ff9d238b85b1430829))

## [0.2.1](https://github.com/AnsoCode/Sencho/compare/v0.2.0...v0.2.1) (2026-03-24)

### Fixed

* **editor:** bundle Monaco locally to fix stuck Loading state ([0eaa45b](https://github.com/AnsoCode/Sencho/commit/0eaa45bd7f5a4b5db9d51a577d25175bbcb4ff77))
* **editor:** bundle Monaco locally to fix stuck Loading state and CSP block ([79fde6e](https://github.com/AnsoCode/Sencho/commit/79fde6e2bd598085abfc7c702f5745bdfd692aec))
* **editor:** Monaco CSP fix + release pipeline fixes ([36a9bf3](https://github.com/AnsoCode/Sencho/commit/36a9bf3109c096ddd5d8095089a6ffb7bd6dee8d))
* **editor:** Monaco CSP fix + release pipeline fixes - v0.2.1 ([36a9bf3](https://github.com/AnsoCode/Sencho/commit/36a9bf3109c096ddd5d8095089a6ffb7bd6dee8d))

## [0.2.0](https://github.com/AnsoCode/Sencho/compare/v0.1.0...v0.2.0) (2026-03-24)

### Added

* **ci:** add release-please automated versioning workflow ([c2d5d37](https://github.com/AnsoCode/Sencho/commit/c2d5d37be41267e71bb8515010b049fcd31f5d6b))
* **ci:** automated versioning with release-please ([c991b81](https://github.com/AnsoCode/Sencho/commit/c991b8121edcd30bd6806e959d0dcd14711f439f))

### Fixed

* **ci:** correct release-please changelog section names and tag format ([ea57cbe](https://github.com/AnsoCode/Sencho/commit/ea57cbe97f7f4166c747f3e3710f85e57ab476a1))
* **ci:** release-please config corrections ([b6391b9](https://github.com/AnsoCode/Sencho/commit/b6391b96ffd4edf7a303350f7416ab1945136e1b))

## [0.1.0] - 2026-03-24

First public release of Sencho.

### Security

- Closed an authentication gap on several notification and console endpoints that were missing session checks.
- Added strict validation for remote node URLs to block pointing a node at loopback or internal services (prevents server-side request forgery from node configuration).
- Prevented path traversal through env_file entries in compose files: all resolved env file paths are now confined to the stack's own directory.
- Extended stack name validation to every route so traversal-style names are rejected consistently.
- Hardened the Host Console working-directory parameter to reject paths outside the configured compose base directory.
- Host Console now launches shells with a sanitized environment so Sencho's own secrets (signing key, stored credentials, database URL) are not inherited by the terminal.
- Host Console and container exec WebSockets now reject node-to-node proxy tokens, which are only valid for API forwarding.
- Settings responses no longer expose auth credential fields, and settings writes reject any attempt to modify auth keys.
- Added login and setup rate limiting to slow down brute-force attempts.
- Added standard security response headers (frame, content-type, referrer, etc.).
- CORS is now restricted to the configured frontend origin in production.

### Added

#### Infrastructure

- linux/arm64 images published alongside linux/amd64, so Sencho runs natively on Raspberry Pi 4/5 and ARM cloud VMs.
- Automated Docker Hub publishing pipeline for dev and latest images.
- Automated documentation and screenshot refresh pipeline.
- Container health check so Docker can auto-restart an unhealthy Sencho instance.
- Public /api/health endpoint for uptime monitoring and load balancer probes.
- Graceful shutdown: Sencho drains in-flight requests, stops background workers, and closes its database before exiting.
- Initial backend unit test suite and end-to-end test suite covering auth, stacks, and node management.

#### Multi-Node & Distributed API

- Distributed API proxy architecture: manage remote Sencho instances over HTTP/WebSocket using a long-lived API token. This replaces the previous SSH/SFTP remote node model entirely.
- Node-to-node authentication tokens generated from the Nodes settings tab.
- Node management UI: add, edit, delete, and test remote nodes.
- Top-bar context pill that always shows which node is currently active (green for local, blue pulse for remote).
- Cross-node notifications: the notification bell aggregates alerts from every connected node in real time.
- Host Console and container exec are now available on remote nodes via a short-lived proxied session.
- Settings panel automatically scopes its tabs to the active node type so global-only settings are hidden when a remote node is selected.

#### Application Features

- **App Store** powered by the LinuxServer.io template registry: browse templates with rich metadata, deploy in one click, edit ports/volumes/env vars before deploy, and auto-rollback on failure. Custom Portainer v2 registry URLs are also supported.
- **Resources Hub** with Images, Volumes, and Networks tabs, Managed/External/Unused classification, a Docker disk footprint widget, and scoped prune operations (Sencho-only vs. all Docker).
- **Global Observability** dashboard with historical CPU/RAM charts and a centralized tail-logs view across every container, including multi-stack filtering, search, and live SSE streaming.
- **Background image update checker** that quietly polls your registries and badges stacks whose images have a newer version available.
- **Real-time WebSocket notifications** replacing the old polling model: alerts arrive the moment they fire.
- **Live container logs** viewer with real-time streaming.
- Animated design system overhaul with new brand color, spring-based motion on dialogs and tooltips, reduced-motion support, and the Geist font family.
- Theme-aware sidebar logo with dark/light variants and an Auto theme that follows the system preference.
- Bulk settings save endpoint with atomic persistence (either every setting saves or none do).
- Active/external container split in the dashboard Active Containers card.
- Two-Stage Teardown on stack deletion so ghost networks are always cleaned up before the files are removed.
- Custom environment variable injection in the deploy flow.
- Root-level error boundary so an unexpected crash lands on a friendly screen instead of a blank page.

### Fixed

#### Authentication & Proxy

- Remote node auth failures no longer trigger a full logout of the local session.
- JSON request bodies are now forwarded correctly to remote nodes (previously the body could be dropped under certain timing conditions).
- Browser session cookies are stripped from remote-node requests so the remote instance uses the proxy Bearer token exclusively.
- Deleted-node recovery: the frontend can now re-sync to a valid node after its active node has been removed, instead of getting stuck on an unreachable ID.
- Fixed a backend memory leak where the remote proxy was being re-instantiated on every API call.

#### WebSockets & Streaming

- Container stats streams no longer flood the UI with hundreds of updates per second; updates are now batched and flushed on a steady cadence.
- Docker stats streams and exec sessions are now cleanly torn down when the client disconnects, so they no longer leak file descriptors.
- Reliable reconnect strategy for notification WebSockets, with exponential backoff.
- Terminal logs, host console, and container stats now work correctly through the remote node proxy.

#### UI & Frontend

- Sencho now loads correctly over plain HTTP without the browser silently upgrading requests or complaining about security headers.
- Monaco editor workers and WebSocket connections are no longer blocked by the default content security policy.
- Several edge cases in the Docker socket permission detection logic now handled correctly.
- Managed vs. external container counts are now accurate when stacks are launched from the compose base directory itself.
- Fixed a browser out-of-memory crash in the global logs view when streaming high-volume containers.
- Many small UI polish items: tooltip crashes, dialog animations, button spacing, menu toggles, tab height accumulation, scrollbar styling in dark mode, and more.
- Remote-node "Open App" button now resolves the hostname from the remote node's API URL instead of assuming localhost.
- Dashboard cards and stack lists now update immediately when switching between nodes.
- Active node state is now hydrated from local storage on first paint so there is no visible flash of the wrong node.
- Historical metrics polling and log buffers are now capped to avoid long-session memory creep.

### Changed

- **Architecture:** replaced the SSH/SFTP remote node model with the Distributed API proxy. Adding a remote node now only requires its URL and an API token, no SSH keys.
- **Docs:** bootstrapped the full user-facing documentation (configuration, stack management, editor, multi-node, alerts, dashboard, resources, app store, observability, settings reference, troubleshooting, backup & restore).
- **Design system:** new brand accent color, refreshed dark-mode shadows, and a consistent animation language across dialogs, tooltips, switches, and tabs.
- Notification delivery moved from polling to real-time push.
- Rebranded a few areas for clarity: "Templates" is now "App Store", "Ghost Containers" is now "Unmanaged Containers", and the standalone "Observability" section is now "Logs".
- Global logs display chronologically (newest at the bottom) with smooth auto-scroll, and timestamps are shown in your local browser timezone.

### Removed

- The entire SSH/SFTP remote node adapter layer, superseded by the Distributed API proxy.

[0.1.0]: https://github.com/AnsoCode/Sencho/releases/tag/v0.1.0
