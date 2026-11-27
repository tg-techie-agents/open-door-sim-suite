# Project file format

A UTF-8 JSON file holding folders, modules, links, views, and baselines. Load it
with `node src/cli.ts import DB file.json`; write one with
`node src/cli.ts export DB file.json`. `examples/example-project.json` is a
worked example. Loading is all or nothing, and an unknown key is an error, so a
misspelling cannot silently drop content.

```json
{
  "format": "opendoor-project",
  "version": 1,
  "folders": [{"path": "/Demo", "project": true, "description": "..."}],
  "link_modules": [{"path": "/Demo/satisfies"}],
  "modules": [
    {
      "path": "/Demo/System Requirements",
      "prefix": "SRS-",
      "description": "...",
      "types": [{"name": "Priority", "base": "Enumeration", "values": ["High", "Low"]}],
      "attributes": [
        {"name": "Priority", "type": "Priority", "default": "Low"},
        {"name": "Owner", "type": "String", "scope": "module"}
      ],
      "module_values": {"Owner": "Systems lead"},
      "objects": [
        {"number": 1, "heading": "Power", "children": [
          {"number": 2, "text": "The unit shall ...", "values": {"Priority": "High"}},
          {"number": 3, "text": "Withdrawn.", "deleted": true}
        ]}
      ],
      "views": {"Review": {"columns": ["ID", "Object Text", "Priority"], "filter": null, "sort": null}}
    }
  ],
  "links": [{"module": "/Demo/satisfies", "from": "SRS-2", "to": "STK-1"}],
  "steps": [
    {"op": "baseline", "module": "/Demo/System Requirements", "annotation": "Review 1"},
    {"op": "set", "object": "SRS-2", "text": "The unit shall now ..."}
  ]
}
```

(The sample link assumes a second module with prefix `STK-`.)

## Modules and objects

- `types`: only your own. `String`, `Text`, `Integer`, `Real`, `Date`, and
  `Boolean` already exist. `base` is one of the first five or `Enumeration`.
- `attributes`: `name`, `type`, and optionally `scope` (`"module"`), `multi`
  (enumerations only), `default`, and `dxl`. `Object Heading`, `Object Short
  Text`, and `Object Text` always exist.
- `dxl` is attribute DXL, the code that calculates the value: only on a
  single-valued object attribute without a `default`. Objects give no value for
  it, and calculated values are not written to the file.
- Objects: `heading`, `short_text`, and `text` are those three attributes; others
  go in `values`. A multi-valued attribute takes a list.
- `number` is the absolute number. It may be left out; such objects are numbered
  after the highest one given.
- `deleted`: soft-deleted. Its children must be deleted too.
- `next_number`: only needed if higher numbers were used and then purged.

## Links

`from` and `to` are identifiers (prefix plus number). Where two modules share a
prefix, write `{"module": "/path", "number": 4}`. `module` is the link module's
full path. A link points from the lower-level or test object (`from`) up to what
it satisfies or verifies (`to`). `"suspect": ["source"]` or `["target"]` marks
that end as changed since the link was reviewed. The file does not hold the
edits themselves, so loading it adds none to history.

## Views

A view has either `columns`, the attributes shown after the ID and main
columns, or `layout`, every column in order, as a view saved by DXL has. Each
`layout` entry has `kind` (`id`, `main`, `attribute`, `dxl`, `blank`), `title`,
`width` (pixels), `justify` (`left`, `right`, `center`, `full`), and
`attribute` or `dxl` for those kinds. `filter` is
`{"attribute", "op", "value"}` or null, and `sort` is a name or null.

## Steps

Edits applied in order after everything above, to give a file a past:

| `op` | other keys |
| --- | --- |
| `baseline` | `module`, `annotation`, `major`, `suffix` |
| `set` | `object`, then `heading`, `text`, `values` |
| `add` | `module`, `under` / `after` / `before` (an identifier), `heading`, `text`, `values` |
| `delete` | `object` |
| `link`, `unlink` | `module` (link module path), `from`, `to` |

## Baselines in an exported file

An optional top-level `"created_on": "2026-01-12 09:00:00"` dates everything
loaded before the `steps`, so the steps' edits read as later ones (for date-based
reports).

An export writes no `steps`. Each module instead carries `baselines`, oldest
first: the same keys as a module's content, plus `major`, `minor`, `suffix`,
`annotation`, `created_on`, and the baseline's outgoing `links` (`from` is a
number in this module).

## Not kept by export and reload

History, who created or changed things and when (including a baseline's author
and date), and soft-deleted folders and modules. Suspect marks are restored link
by link; in rare cases where several links share objects, one may come back
marked on both ends instead of one.
