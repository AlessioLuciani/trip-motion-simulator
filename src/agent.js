const fs = require("fs");
const turf = require("@turf/turf");
const tilebelt = require("@mapbox/tilebelt");
const cover = require("@mapbox/tile-cover");
const Status = require("./status");

var Agent = function (simulation, opts, config, logger) {
  this.logger = logger;
  this.probes = opts.probes;
  this.traces = opts.traces;
  this.trips = opts.trips;
  this.changes = opts.changes;
  this.simulation = simulation;
  this.config = config;
  this.status = Status.ACTIVATING;
  this.speed = Math.abs(this.simulation.chance.normal({ mean: 1, dev: 0.1 }));
  this.breakdown =
    this.simulation.time +
    Math.abs(
      config.timeToBreakage * this.simulation.chance.normal({ mean: 1, dev: 1 })
    );
  this.shift =
    this.simulation.time +
    Math.abs(
      config.serviceDuration *
        this.simulation.chance.normal({ mean: 1, dev: 1 })
    );
  this.id = [
    this.simulation.chance.letter({ casing: "upper" }),
    this.simulation.chance.letter({ casing: "upper" }),
    this.simulation.chance.letter({ casing: "upper" }),
    "-",
    this.simulation.chance.character({ pool: "0123456789" }),
    this.simulation.chance.character({ pool: "0123456789" }),
    this.simulation.chance.character({ pool: "0123456789" }),
    this.simulation.chance.character({ pool: "0123456789" }),
  ].join("");
  this.acceleration = {
    x: 0.0,
    y: 0.0,
    z: 0.0,
  };
  this.rotationRate = {
    x: 0.0,
    y: 0.0,
    z: 0.0,
  };
  this.heading = 0.0;
  // route step reached so far in the simulation
  this.stepReached = 0;
  // sum of distances of all steps covered so far
  this.totalCoveredStepsDistance = 0.0;
  // distance covered with a single hop
  this.hopDistance = 0.0;
};

Agent.prototype.step = async function () {
  if (this.status === Status.ACTIVATING) {
    // transition to idling
    this.status = Status.IDLING;
    // set idling duration
    if (this.config.idleTimeBetweenTrips > 0) {
      this.next =
        this.simulation.time +
        Math.abs(
          this.config.idleTimeBetweenTrips *
            this.simulation.chance.normal({
              mean: 1,
              dev: 1,
            })
        );
    } else this.next = -1;

    // place vehicle
    await this.place();

    // log status_change: available, service_start
    if (this.changes) {
      var change = {
        vehicle_id: this.id,
        event_time: this.simulation.time,
        event_type: "available",
        event_type_reason: "service_start",
        event_location: turf.point(this.gps()),
      };

      fs.appendFileSync(this.changes, JSON.stringify(change) + "\n");
    }
  } else if (this.status === Status.IDLING) {
    // if idle duration expired, transition to searching
    if (this.simulation.time >= this.next) {
      // if search distance is zero, skip to traveling
      if (this.config.distanceBetweenTrips > 0) {
        this.status = Status.SEARCHING;

        // calculate search range
        const range = Math.abs(
          this.config.distanceBetweenTrips *
            this.simulation.chance.normal({
              mean: 1,
              dev: 1,
            })
        );
        // select search route
        await this.route(range);
      } else {
        this.status = Status.TRAVELING;

        // log status_change: reserved, user_pick_up
        if (this.changes) {
          var change = {
            vehicle_id: this.id,
            event_time: this.simulation.time,
            event_type: "reserved",
            event_type_reason: "user_pick_up",
            event_location: turf.point(this.gps()),
          };
          fs.appendFileSync(this.changes, JSON.stringify(change) + "\n");
        }

        // calculate travel range
        const range = Math.abs(
          this.config.tripDistance *
            this.simulation.chance.normal({
              mean: 1,
              dev: 1,
            })
        );

        // select travel route
        await this.route(range);
      }
    }
  } else if (this.status === Status.SEARCHING) {
    // set vehicle location by % search route complete
    const progress =
      (this.simulation.time - this.start) / (this.next - this.start);
    this.location = turf.along(
      this.path.line,
      progress * this.path.distance || 0
    ).geometry.coordinates;

    // if search duration expired, transition to traveling
    if (this.simulation.time >= this.next) {
      this.status = Status.TRAVELING;

      // log status_change: reserved, user_pick_up
      if (this.changes) {
        var change = {
          vehicle_id: this.id,
          event_time: this.simulation.time,
          event_type: "reserved",
          event_type_reason: "user_pick_up",
          event_location: turf.point(this.gps()),
        };
        fs.appendFileSync(this.changes, JSON.stringify(change) + "\n");
      }

      // calculate travel range
      const range = Math.abs(
        this.config.tripDistance *
          this.simulation.chance.normal({
            mean: 1,
            dev: 1,
          })
      );

      // select travel route
      await this.route(range);
    }
  } else if (this.status === Status.TRAVELING) {
    // set vehicle location by % travel route complete
    let progress =
      (this.simulation.time - this.start) / (this.next - this.start);
    progress = Math.max(Math.min(1.0, progress), 0.0);

    const coveredDistance = progress * this.path.distance;

    this.location = turf.along(
      this.path.line,
      coveredDistance
    ).geometry.coordinates;

    // updating the current step based on the distance covered with this hop
    let newCovering = coveredDistance * 1000 - this.totalCoveredStepsDistance;
    while (
      newCovering >= 0 &&
      this.stepReached < this.path.legs[0].steps.length - 2
    ) {
      const stepDistance = this.path.legs[0].steps[this.stepReached].distance;
      newCovering -= stepDistance;
      if (newCovering >= 0) {
        this.totalCoveredStepsDistance += stepDistance;
        this.stepReached++;
      }
    }
    // on arrival placing the agent back to the end of the last step
    if (this.stepReached >= this.path.legs[0].steps.length - 2) {
      this.stepReached = this.path.legs[0].steps.length - 2;
      newCovering = 0;
    }

    this.logger.debug("Step reached: " + this.stepReached);
    this.logger.debug("Covered distance: " + coveredDistance * 1000);
    this.logger.debug("Progress: " + progress);

    const stepDistance = this.path.legs[0].steps[this.stepReached].distance;
    // distance covered on current step
    const stepCovering = newCovering + stepDistance;
    // progress on the current step
    const progressOnStep = stepCovering / stepDistance;

    // updating heading linearly interpolating between two steps
    this.updateHeading(progressOnStep, stepCovering, stepDistance);

    this.logger.debug("Heading: " + this.heading);

    // updating acceleration
    this.updateAcceleration(progressOnStep, stepCovering, stepDistance);

    this.logger.debug("Acceleration X: " + this.acceleration.x);
    this.logger.debug("Acceleration Y: " + this.acceleration.y);
    this.logger.debug("Rotation Rate Z: " + this.rotationRate.z);

    // if breakdown triggered, transition to broken
    if (this.simulation.time >= this.breakdown) {
      this.status = Status.BROKEN;

      // log status_change: unavailable, maintenance
      if (this.changes) {
        var change = {
          vehicle_id: this.id,
          event_time: this.simulation.time,
          event_type: "unavailable",
          event_type_reason: "maintenance",
          event_location: turf.point(this.gps()),
        };
        fs.appendFileSync(this.changes, JSON.stringify(change) + "\n");
      }

      // log trip
      if (this.trips) {
        const trip = {
          vehicle_id: this.id,
          trip_duration: this.path.duration / 1000,
          trip_distance: this.path.distance * 1000,
          start_time: this.start,
          end_time: this.next,
          route: turf.featureCollection(
            this.path.line.geometry.coordinates.map((c, i) => {
              return turf.point(this.gps(c), {
                // interpolate timestamp from this.start
                timestamp: this.start + i * this.simulation.stepSize,
              });
            })
          ),
        };

        fs.appendFileSync(this.trips, JSON.stringify(trip) + "\n");
      }
    }
    // if travel duration expired, transition to idling
    if (this.simulation.time >= this.next) {
      this.status = Status.IDLING;

      // log status_change: available, user_drop_off
      if (this.changes) {
        var change = {
          vehicle_id: this.id,
          event_time: this.simulation.time,
          event_type: "available",
          event_type_reason: "user_drop_off",
          event_location: turf.point(this.gps()),
        };
        fs.appendFileSync(this.changes, JSON.stringify(change) + "\n");
      }

      // log trip
      if (this.trips) {
        const trip = {
          vehicle_id: this.id,
          trip_duration: this.path.duration / 1000,
          trip_distance: this.path.distance * 1000,
          start_time: this.start,
          end_time: this.next,
          route: turf.featureCollection(
            this.path.line.geometry.coordinates.map((c, i) => {
              return turf.point(this.gps(c), {
                // interpolate timestamp from this.start
                timestamp: this.start + i * this.simulation.stepSize,
              });
            })
          ),
        };

        fs.appendFileSync(this.trips, JSON.stringify(trip) + "\n");
      }
    }
  } else if (this.status === Status.BROKEN) {
    // do nothing
  } else if (this.status === Status.DEACTIVATING) {
    // log status_change: unavailable, service_end
    if (this.changes) {
      var change = {
        vehicle_id: this.id,
        event_time: this.simulation.time,
        event_type: "unavailable",
        event_type_reason: "service_end",
        event_location: turf.point(this.gps()),
      };
      fs.appendFileSync(this.changes, JSON.stringify(change) + "\n");
    }
    // kill agent
  }

  // log vehicle probe
  if (this.probes) {
    var probe = turf.point(this.gps(), {
      id: this.id,
      time: this.simulation.time,
      status: String(this.status).slice(7, -1),
    });
    // adding current motion information
    probe["motion"] = {
      acceleration: this.acceleration,
      rotationRate: this.rotationRate,
      heading: this.heading,
    };
    fs.appendFileSync(this.probes, JSON.stringify(probe) + "\n");
  }
};

// update agent heading
Agent.prototype.updateHeading = function (
  progressOnStep,
  stepCovering,
  stepDistance
) {
  let targetHeading = 0.0;
  // interpolating heading between two steps
  let startHeading =
    this.path.legs[0].steps[this.stepReached].maneuver.bearing_after;
  let endHeading =
    this.path.legs[0].steps[this.stepReached + 1].maneuver.bearing_before;
  let headingDiff = endHeading - startHeading;
  let headingShiftSign = Math.abs(headingDiff) > 180 ? -1 : 1;
  headingDiff = adjustTurnHeadingDiff(headingDiff);
  let headingShift = headingDiff * progressOnStep * headingShiftSign;
  targetHeading = startHeading + headingShift;
  targetHeading = shiftHeading(targetHeading);
  // interpolating heading for the step maneuver (~ 30 deg/s)
  let stepIndex =
    progressOnStep >= 0.5 ? this.stepReached + 1 : this.stepReached;
  startHeading = this.path.legs[0].steps[stepIndex].maneuver.bearing_before;
  endHeading = this.path.legs[0].steps[stepIndex].maneuver.bearing_after;
  headingDiff = endHeading - startHeading;
  headingShiftSign = Math.abs(headingDiff) > 180 ? -1 : 1;
  headingDiff = adjustTurnHeadingDiff(headingDiff);
  let maneuverProgress = 0.0;
  let secondsNeeded = Math.abs(headingDiff) / 30;
  let secondsNeededHalved = secondsNeeded / 2;
  if (progressOnStep >= 0.5) {
    // consider following step
    let hopsRemaining = (stepDistance - stepCovering) / this.hopDistance;
    if (hopsRemaining <= secondsNeededHalved) {
      maneuverProgress = (secondsNeededHalved - hopsRemaining) / secondsNeeded;
    }
  } else {
    // consider previous step
    let hopsCompleted = stepCovering / this.hopDistance;
    if (hopsCompleted <= secondsNeededHalved) {
      maneuverProgress = (hopsCompleted + secondsNeededHalved) / secondsNeeded;
    }
  }
  if (!isDepartureOrArrival(stepIndex) && maneuverProgress > 0) {
    // applying when not departure nor arrival
    headingShift = headingDiff * maneuverProgress * headingShiftSign;
    targetHeading = startHeading + headingShift;
    targetHeading = shiftHeading(targetHeading);
  }

  this.heading = targetHeading;
};

// shift heading if it goes out of bounds
function shiftHeading(heading) {
  if (heading < 0) {
    heading += 360;
  }
  if (heading >= 360) {
    heading -= 360;
  }
  return heading;
}

// adjustes heading difference for curve
function adjustTurnHeadingDiff(headingDiff) {
  if (Math.abs(headingDiff) > 180) {
    headingDiff = (headingDiff >= 0 ? 360 : -360) - headingDiff;
  }
  return headingDiff;
}

// checks if the agent is currently at the departure or at the arrival
function isDepartureOrArrival(stepIndex) {
  return (
    stepIndex == 0 ||
    (this.path !== undefined &&
      stepIndex == this.path.legs[0].steps.length - 1 &&
      this.stepReached == stepIndex)
  );
}

// update agent acceleration
Agent.prototype.updateAcceleration = function (
  progressOnStep,
  stepCovering,
  stepDistance
) {
  // acceleration on Y ~ +3 m/s^2 - 3s increasing - 7s decreasing
  // deceleration on Y ~ -4 m/s^2 - 3s decreasing - 3s increasing
  // acceleration on X on right turn ~ for 90 deg. +5 m/s^2 - 3s increasing - 3s decreasing
  // deceleration on X on left turn ~ for 90 deg. -5 m/s^2 - 3s decreasing - 3s increasing
  // rotation rate on Z on right turn ~ for 90 deg. +0.7 - 3s increasing - 3s decreasing
  // rotation rate on Z on left turn ~ for 90 deg. -0.7 - 3s decreasing - 3s increasing

  let stepIndex =
    progressOnStep >= 0.5 ? this.stepReached + 1 : this.stepReached;
  startHeading = this.path.legs[0].steps[stepIndex].maneuver.bearing_before;
  endHeading = this.path.legs[0].steps[stepIndex].maneuver.bearing_after;
  headingDiff = endHeading - startHeading;
  let headingShiftSign = Math.abs(headingDiff) > 180 ? -1 : 1;
  headingDiff = adjustTurnHeadingDiff(headingDiff);
  let goingRight = headingShiftSign * headingDiff >= 0 ? 1 : -1;
  let secondsNeeded = Math.abs(headingDiff) / 30;
  let turningAcceleration = 1.7 * secondsNeeded;
  let turningRotRate = 0.23 * secondsNeeded;
  if (progressOnStep >= 0.5) {
    // consider following step
    let hopsRemaining = (stepDistance - stepCovering) / this.hopDistance;
    // acceleration Y
    if (hopsRemaining <= 3) {
      this.acceleration.y = (hopsRemaining / 3) * -4;
    } else if (hopsRemaining <= 6) {
      this.acceleration.y = ((6 - hopsRemaining) / 3) * -4;
    } else {
      this.acceleration.y = 0;
    }
    // acceleration X
    if (!isDepartureOrArrival(stepIndex)) {
      if (hopsRemaining <= secondsNeeded) {
        this.acceleration.x =
          ((secondsNeeded - hopsRemaining) / secondsNeeded) *
          goingRight *
          turningAcceleration;
      } else {
        this.acceleration.x = 0;
      }
    }
    // rotation rate Z
    if (!isDepartureOrArrival(stepIndex)) {
      if (hopsRemaining <= secondsNeeded) {
        this.rotationRate.z =
          ((secondsNeeded - hopsRemaining) / secondsNeeded) *
          goingRight *
          turningRotRate;
      } else {
        this.rotationRate.z = 0;
      }
    }
  } else {
    // consider previous step
    let hopsCompleted = stepCovering / this.hopDistance;
    // acceleration Y
    if (hopsCompleted <= 3) {
      this.acceleration.y = (hopsCompleted / 3) * 3;
    } else if (hopsCompleted <= 10) {
      this.acceleration.y = ((10 - hopsCompleted) / 7) * 3;
    } else {
      this.acceleration.y = 0;
    }

    // acceleration X
    if (!isDepartureOrArrival(stepIndex)) {
      if (hopsCompleted <= secondsNeeded) {
        this.acceleration.x =
          ((secondsNeeded - hopsCompleted) / secondsNeeded) *
          goingRight *
          turningAcceleration;
      } else {
        this.acceleration.x = 0;
      }
    }
    // rotation rate Z
    if (!isDepartureOrArrival(stepIndex)) {
      if (hopsCompleted <= secondsNeeded) {
        this.rotationRate.z =
          ((secondsNeeded - hopsCompleted) / secondsNeeded) *
          goingRight *
          turningRotRate;
      } else {
        this.rotationRate.z = 0;
      }
    }
  }
};

Agent.prototype.gps = function (coordinate) {
  var drifted = turf.destination(
    turf.point(coordinate || this.location),
    this.simulation.chance.normal() * this.config.horizontalAccuracy,
    this.simulation.chance.normal() * 360
  ).geometry.coordinates;

  return drifted;
};

// select starting location
Agent.prototype.place = async function () {
  // pick a quadkey
  const quadkey = this.simulation.chance.weighted(
    this.simulation.quadranks,
    this.simulation.quadscores
  );
  const bbox = tilebelt.tileToBBOX(tilebelt.quadkeyToTile(quadkey));

  // select random point within bbox
  const pt = [
    this.simulation.chance.longitude({ min: bbox[0], max: bbox[2] }),
    this.simulation.chance.latitude({ min: bbox[1], max: bbox[3] }),
  ];

  // snap to graph
  const snapped = await this.simulation.snap(pt);
  this.location = snapped;
};

// select route
Agent.prototype.route = async function (range) {
  try {
    // buffer location to range
    const buffer = turf.buffer(turf.point(this.location), range).geometry;
    // compute quadkeys to query
    const quadkeys = cover.indexes(buffer, this.simulation.Z);
    // select random quadkey by rank
    const scores = quadkeys.map((q) => {
      var score = this.simulation.quadtree.get(q);
      return this.simulation.quadtree.get(q) || 0;
    });

    const quadkey = this.simulation.chance.weighted(quadkeys, scores);
    const bbox = tilebelt.tileToBBOX(tilebelt.quadkeyToTile(quadkey));
    // select random destination within bbox
    var destination = [
      this.simulation.chance.longitude({ min: bbox[0], max: bbox[2] }),
      this.simulation.chance.latitude({ min: bbox[1], max: bbox[3] }),
    ];
    // snap destination to graph
    destination = await this.simulation.snap(destination);
    // route from location to destination
    this.path = await this.simulation.route(this.location, destination);
    this.path.duration = this.path.duration * this.speed * 1000;
    this.path.line = turf.lineString(this.path.geometry.coordinates);
    this.path.distance = turf.length(this.path.line);
    this.start = this.simulation.time;
    this.next = this.simulation.time + this.path.duration;

    // resetting steps progress
    this.stepReached = 0;
    this.totalCoveredStepsDistance = 0.0;
    // resetting initial heading at departure
    this.heading = this.path.legs[0].steps[0].maneuver.bearing_after;
    // resetting hop distance
    this.hopDistance =
      (this.simulation.stepSize / (this.next - this.start)) *
      this.path.distance *
      1000;

    this.logger.debug("STEPS NUMBER: " + this.path.legs[0].steps.length);
    this.logger.debug("TOTAL DISTANCE: " + this.path.distance * 1000);
    for (let step of this.path.legs[0].steps) {
      this.logger.debug(step.maneuver);
    }

    if (this.path.distance === 0) {
      return await this.route(range * 1.5);
    }

    if (this.traces) {
      fs.appendFileSync(
        this.traces,
        JSON.stringify(
          turf.lineString(
            this.path.line.geometry.coordinates.map((c) => {
              return this.gps(c);
            }),
            { d: this.path.distance }
          )
        ) + "\n"
      );
    }
  } catch (e) {
    return this.route(range * 1.5);
  }
};

module.exports = Agent;
