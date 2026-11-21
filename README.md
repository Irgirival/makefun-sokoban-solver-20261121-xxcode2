# Sokoban Solver — make.fun · sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Irgirival/makefun-sokoban-solver-20261121-xxcode2/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Irgirival/makefun-sokoban-solver-20261121-xxcode2/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver written in pure TypeScript (Node 22, standard library only).

## How it works

1. **Room decomposition.** The level is cut into rooms: the player's row is the hallway, and each connected component of boxes (with its door) is a room. This matches the competition's level construction (rooms are independent; the optimum is the sum of room optima).
2. **Push-optimal A\*** per room. The search runs over pushes (not steps), with a minimum-matching heuristic (each box assigned to a distinct goal by cheapest BFS distance), dead-square pruning (reverse pull-reachability), frozen 2×2-block pruning, and a transposition table keyed on the sorted box set plus the lowest reachable player square.
3. **Deterministic stitching.** Rooms are solved independently and joined by BFS walks through the hallway. A fallback ladder (plain A\* → weighted A\* → greedy) covers any level that does not decompose cleanly.
4. **Deterministic by construction.** The budget is counted in expansions, never in wall-clock time; the program reads no clock and uses no randomness, so two runs on the same input produce byte-identical solutions.

## Results

| Set | Solved | Score |
| --- | --- | --- |
| Practice set (kit) | 5/5, all at P* | 1,000,000 |
| 10 freshly drawn sets (comp generator, 50 levels) | 50/50, all at P* | 1,000,000 |

Worst solve time on the 50 generated levels: 4.3 s (limit: 60 s for the whole set).

## Usage

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

Reads `/input/<id>/level.txt` (XSB format) for every instance directory and writes `/output/<id>/solution.txt` (player moves: `u`/`d`/`l`/`r` for walks, `U`/`D`/`L`/`R` for pushes).

## License

MIT — see `LICENSE`.
