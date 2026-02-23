---
"wrangler": minor
"@cloudflare/workers-utils": minor
---

Add `cache` configuration option for enabling worker cache

You can now enable cache before worker execution using the new `cache` configuration:

```jsonc
{
	"cache": {
		"enabled": true,
	},
}
```

This setting is environment-inheritable and opt-in. When enabled, cache behavior is applied before your worker runs.
