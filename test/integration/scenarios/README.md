# Integration Scenario Templates

`_template.json` is a scaffold for new game integration scenarios and is not
executed by the test runner. Copy it to a new file and fill in real intents and
expectations for the target ruleset.

For new games, add `tags` to each scenario (e.g. `basic`, `illegal`, `scoring`,
`round-reset`, `auto-playthrough`) so `npm run check:game-scenarios -- <rulesId>`
can verify minimum coverage.
