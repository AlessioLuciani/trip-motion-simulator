# Trip Motion Simulator

[![npm](https://img.shields.io/npm/v/trip-motion-simulator)](https://www.npmjs.com/package/trip-motion-simulator)
[![GitHub forks](https://img.shields.io/github/forks/AlessioLuciani/trip-motion-simulator)](https://github.com/AlessioLuciani/trip-motion-simulator/network)
[![GitHub Repo stars](https://img.shields.io/github/stars/AlessioLuciani/trip-motion-simulator)](https://github.com/AlessioLuciani/trip-motion-simulator/stargazers)
[![GitHub](https://img.shields.io/github/license/AlessioLuciani/trip-motion-simulator)](https://github.com/AlessioLuciani/trip-motion-simulator/blob/master/LICENSE)


*A module for generating simulated location and vehicle motion telemetry.*

## Overview

[`trip-motion-simulator`](https://www.npmjs.com/package/trip-motion-simulator) is a [fork](https://github.com/AlessioLuciani/trip-motion-simulator) of [SharedStreets](https://sharedstreets.io)'s [`trip-simulator`](https://www.npmjs.com/package/trip-simulator). It adds to the original package the generation of vehicle motion metrics. These include:

- acceleration on the _X_, _Y_, and _Z_ axes
- rotation rate on the _X_, _Y_, and _Z_ axes
- heading

For additional information about the simulator's features and how to use it, visit the [original repository](https://github.com/sharedstreets/trip-simulator).

## Install

```sh
npm install -g trip-motion-simulator
```

## CLI

```
trip-motion-simulator

-h,--help     show help
--config      config car,bike,scooter
--pbf         osm.pbf file
--graph       osrm graph file
--agents      number of agents
--start       start time in epoch milliseconds
--seconds     number of seconds to simulate
--probes      GeoJSON probes output file
--traces      GeoJSON traces output file
--trips       MDS trips output file
--changes     MDS status changes output file
--log         log level - refer to https://github.com/pinojs/pino/blob/master/docs/api.md#level-1
```

## Test

```sh
npm test
```

## Lint

```sh
npm run lint
```
