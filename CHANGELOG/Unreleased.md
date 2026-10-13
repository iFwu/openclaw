## Unreleased

### Changes

- Plugin SDK: retire the beta.5 whole-store and transcript-file session helpers and package-root load/save aliases. Keep row-level SQLite session APIs and core legacy-data migration intact.
- Fork CI: report compatibility deadlines as review reminders instead of failing unchanged builds when a date passes. Explicit migration audits can still request the strict deadline check.
