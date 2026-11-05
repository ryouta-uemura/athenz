# Local role/group rate-limit demo

This demo runs the repository's actual Next pages and Fetchr API handler on localhost. Only `req.clients.zms` is replaced with a mock. It uses synthetic group names, a dummy session, and sends no production ZMS requests.

The mock exposes three domains, each with one `users` role:

| Domain | Group references | Expected Members page with default limit |
| --- | ---: | --- |
| `domain-with-50` | 50 | Both versions render |
| `domain-with-100` | 100 | Both versions render |
| `domain-with-155` | 155 | Baseline fails with 429; fixed version renders |

The mock routes calls round-robin across eight ZMS instances. Each instance starts with a 20-token bucket and two tokens already used, then refills at 20 tokens per second. A Members page's `getRole` call resets the buckets and counters, making each browser reload a fresh run. This is a controlled illustration, not a prediction of the production load balancer's distribution.

## Start both versions

From this `ui/` directory, run each command in a separate terminal:

```sh
node demo/role-group-rate-limit/real-ui-server.cjs /private/tmp/athenz-lazy-role-group-members-20261029/ui
```

```sh
DEMO_PORT=4181 node demo/role-group-rate-limit/real-ui-server.cjs /private/tmp/athenz-role-group-baseline-20261030/ui
```

The fixed version (`8acb4f2ed`) uses port 4180; the baseline (`ee64e5f71`) uses port 4181.

## Open in a browser

| Domain | Baseline Members | Fixed Members |
| --- | --- | --- |
| 50 groups | http://127.0.0.1:4181/domain/domain-with-50/role/users/members | http://127.0.0.1:4180/domain/domain-with-50/role/users/members |
| 100 groups | http://127.0.0.1:4181/domain/domain-with-100/role/users/members | http://127.0.0.1:4180/domain/domain-with-100/role/users/members |
| 155 groups | http://127.0.0.1:4181/domain/domain-with-155/role/users/members | http://127.0.0.1:4180/domain/domain-with-155/role/users/members |

For the role listing, replace `/role/users/members` with `/role` in any URL. Open a group menu on the fixed Members page to see its one-on-demand `getGroup` call. Each server's `http://127.0.0.1:PORT/__demo/stats` shows `getRole`, `getGroup`, and rejected counts. The default limit can be restored with `/__demo/reset?capacity=20&otherUsed=2`.

## Measure render time

Start Chrome with a fresh profile:

```sh
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless=new --disable-gpu --no-first-run --disable-background-networking --disable-extensions --user-data-dir=/private/tmp/athenz-real-ui-chrome-cdp --remote-debugging-port=9223 '--remote-allow-origins=*' about:blank
```

Then run:

```sh
node demo/role-group-rate-limit/measure-real-pages.mjs
```

The script measures the listing and Members pages for all three domains, three times each, on both UI versions. It records time until rows appear, the role API duration, and mock call counts. The 50- and 100-group domains allow successful render-time comparison with the default limit; the 155-group domain demonstrates the baseline failure. All timings are from the local mock environment.

In one warm local run, the median Members render times were 745 ms before / 426 ms after for 50 groups, and 779 ms before / 467 ms after for 100 groups. For 155 groups, all three baseline runs hit 429 (155 `getGroup` calls, four rejected), while all three fixed runs rendered (zero initial `getGroup` calls). Listing pages rendered in roughly 0.3–0.4 seconds on both versions.

The separate `server.mjs` demo is a simplified visualization of the request sequence, available at `http://127.0.0.1:4177` after running `node demo/role-group-rate-limit/server.mjs`. It does not run the Next pages.
