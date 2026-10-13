## Unreleased

### Changes

- Plugin SDK: retire the beta.5 whole-store and transcript-file session helpers and package-root load/save aliases. Keep row-level SQLite session APIs and core legacy-data migration intact.
- Fork CI: report compatibility deadlines as review reminders instead of failing unchanged builds when a date passes. Explicit migration audits can still request the strict deadline check.

### Fixes

- Automatic continuation: preserve an admitted turn's selected primary model and turn options across Gateway restart recovery and native subagent completion, resolve inherited parent model choices, and invalidate stale snapshots after newer selections or ordinary turns without persisting fallback models as the primary.
