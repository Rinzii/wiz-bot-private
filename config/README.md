# Configuration Files

This project keeps real configuration out of source control. Copy whichever examples you
need and adjust them locally:

```bash
cp config/default.example.jsonc config/default.jsonc
cp config/local.example.jsonc config/local.jsonc
```

Any `*.jsonc` file that is not suffixed with `.example` is ignored by git, so you can safely
add secrets or environment-specific overrides without committing them.
