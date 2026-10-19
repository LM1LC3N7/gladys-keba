# Third-party notices

This integration is distributed under the Apache License 2.0 (see `LICENSE`).
It contains no third-party code at runtime other than its npm dependencies
(`@gladysassistant/integration-sdk` and what it pulls, each under its own
license in `node_modules`).

## keba-kecontact

The KEBA UDP protocol handling (`src/keba/protocol.js`, `src/keba/channel.js`:
the answer kinds, the product string, the report units, the command texts,
the port and the pause between two messages) is a JavaScript port of parts of
**keba-kecontact** 4.3.1 (https://github.com/dannerph/keba-kecontact, commit
e9f04eb), the library used by Home Assistant's KEBA integration, distributed
under the MIT License:

```
MIT License

Copyright (c) 2019 Philipp Danner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

KEBA and KeContact are trademarks of KEBA AG; BMW is a trademark of BMW AG.
This integration is not affiliated with, endorsed or sponsored by them.
