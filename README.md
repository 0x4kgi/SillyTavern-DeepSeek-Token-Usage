# SillyTavern DeepSeek (Simple) Token Usage (viewer)

![](img/screenshot.png)

## Features

Shows the token usage that is returned by DeepSeek's API in a convenient(-ish) way.

## Installation and Usage

### Installation

Using ST's built in installer

```
https://github.com/0x4kgi/SillyTavern-DeepSeek-Token-Usage
```

### Usage

Just open the extensions tab.

## Prerequisites

Tested on ST 1.18.0. Might work on older.

This extension is written with the DeepSeek's API in mind. Might work with other APIs if they also return the following schema:

```json
"usage": {
  "prompt_tokens": x,
  "completion_tokens": x,
  "total_tokens": x,
  "prompt_tokens_details": {
    "cached_tokens": x
  },
  "completion_tokens_details": {
    "reasoning_tokens": x
  },
  "prompt_cache_hit_tokens": x,
  "prompt_cache_miss_tokens": x
}
```

## AI Disclosure

Vibe coded with Google Gemini.

## Special Thanks

[city-unit's st-extension-example](https://github.com/city-unit/st-extension-example) for the template.

## License

**Unlicense**. Just Because.
