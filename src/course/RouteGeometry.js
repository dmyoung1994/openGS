const EPSILON = 1e-9;

export function transformLocalPoint(point, placement) {
  const radians = placement.bearingDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: placement.origin.x + point.x * cosine - point.z * sine,
    z: placement.origin.z + point.x * sine + point.z * cosine,
  };
}

export function inverseSitePoint(point, placement) {
  const radians = placement.bearingDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - placement.origin.x;
  const dz = point.z - placement.origin.z;
  return { x: dx * cosine + dz * sine, z: -dx * sine + dz * cosine };
}

export function transformTee(tee, placement) {
  const center = transformLocalPoint(tee, placement);
  const shape = [
    { x: tee.x - tee.boxHalfX, z: tee.z0 },
    { x: tee.x + tee.boxHalfX, z: tee.z0 },
    { x: tee.x + tee.boxHalfX, z: tee.z1 },
    { x: tee.x - tee.boxHalfX, z: tee.z1 },
  ].map((point) => transformLocalPoint(point, placement));
  return {
    x: center.x,
    z: center.z,
    boxHalfX: tee.boxHalfX,
    z0: Math.min(...shape.map((point) => point.z)),
    z1: Math.max(...shape.map((point) => point.z)),
    shape,
  };
}

export function compileRouteCorridor(route) {
  if (route?._compiledRoute === true) return route;
  const points = route?.points ?? [];
  const c0 = route?.c0 ?? route?.fairwayHalfWidth;
  const k = route?.k ?? 0;
  const rough = route?.rough ?? route?.roughWidth ?? 0;
  const segments = [];
  let cursor = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length <= EPSILON) continue;
    segments.push({ a, b, dx, dz, length, lengthSq: length * length, start: cursor });
    cursor += length;
  }
  return Object.freeze({
    ...route,
    c0,
    k,
    rough,
    length: cursor,
    segments: Object.freeze(segments),
    ...(route.fairwayStartMeters > 0 ? {
      // Only the maintained corridor is clipped. Full route geometry/length
      // remains authoritative for strategy, yardage and camera/aim projection.
      surfaceSegments: Object.freeze(segments.flatMap(segment => {
        if (segment.start + segment.length <= route.fairwayStartMeters) return [];
        if (segment.start >= route.fairwayStartMeters) return [segment];
        const removed = route.fairwayStartMeters - segment.start;
        const fraction = removed / segment.length;
        const length = segment.length - removed;
        return [{...segment,
          a: {x:segment.a.x + segment.dx*fraction,z:segment.a.z + segment.dz*fraction},
          dx:segment.dx*(1-fraction),dz:segment.dz*(1-fraction),
          length,lengthSq:length*length,start:route.fairwayStartMeters,
        }];
      })),
    } : {}),
    _compiledRoute: true,
  });
}

export function routeCorridorSignedDistance(rawRoute, x, z) {
  return projectRoute(rawRoute, x, z, true).signedDistance;
}

// One authoritative route query for authoring audits, CPU terrain classification,
// selection, and deterministic camera placement. Width follows the same arc-length
// law used by the baked zone map.
export function routeProjection(rawRoute, x, z) {
  return projectRoute(rawRoute, x, z, false);
}

function projectRoute(rawRoute, x, z, maintained) {
  const route = compileRouteCorridor(rawRoute);
  let best = null;
  for (const segment of maintained ? route.surfaceSegments ?? route.segments : route.segments) {
    const t = Math.max(0, Math.min(1, ((x - segment.a.x) * segment.dx + (z - segment.a.z) * segment.dz) / segment.lengthSq));
    const qx = segment.a.x + segment.dx * t;
    const qz = segment.a.z + segment.dz * t;
    const along = segment.start + segment.length * t;
    const halfWidth = route.c0 + along * route.k;
    const distance = Math.hypot(x - qx, z - qz);
    const signedDistance = halfWidth - distance;
    if (!best || signedDistance > best.signedDistance) best = {
      signedDistance, distance, closest: { x: qx, z: qz },
      tangent: { x: segment.dx / segment.length, z: segment.dz / segment.length },
      progress: route.length > EPSILON ? along / route.length : 0,
      along, halfWidth,
    };
  }
  return best ?? {
    signedDistance: -Infinity, distance: Infinity, closest: null,
    tangent: { x: 0, z: -1 }, progress: 0, along: 0, halfWidth: 0,
  };
}

export function nearestRouteSignedDistance(routes, x, z) {
  let best = -Infinity;
  for (const route of routes ?? []) best = Math.max(best, routeCorridorSignedDistance(route, x, z));
  return best;
}

export function polylineLength(points) {
  let length = 0;
  for (let index = 1; index < (points?.length ?? 0); index += 1) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
  }
  return length;
}

export function routeAim(route) {
  const points = route?.points ?? [];
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index].x - points[index - 1].x;
    const dz = points[index].z - points[index - 1].z;
    const length = Math.hypot(dx, dz);
    if (length > EPSILON) return { x: dx / length, z: dz / length };
  }
  return { x: 0, z: -1 };
}

export function pointToPolylineDistance(point, points) {
  let best = Infinity;
  for (let index = 0; index < (points?.length ?? 0) - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const denominator = dx * dx + dz * dz;
    const t = denominator > EPSILON
      ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / denominator))
      : 0;
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t)));
  }
  return best;
}

export function polylineDistance(first, second) {
  let best = Infinity;
  for (let a = 0; a < (first?.length ?? 0) - 1; a += 1) {
    for (let b = 0; b < (second?.length ?? 0) - 1; b += 1) {
      best = Math.min(best, segmentDistance(first[a], first[a + 1], second[b], second[b + 1]));
    }
  }
  return best;
}

export function polylinesCross(first, second) {
  for (let a = 0; a < (first?.length ?? 0) - 1; a += 1) {
    for (let b = 0; b < (second?.length ?? 0) - 1; b += 1) {
      if (segmentsIntersect(first[a], first[a + 1], second[b], second[b + 1])) return true;
    }
  }
  return false;
}

function segmentDistance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b),
  );
}

function pointSegmentDistance(point, a, b) {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const denominator = dx * dx + dz * dz;
  const t = denominator > EPSILON
    ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / denominator))
    : 0;
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

function segmentsIntersect(a, b, c, d) {
  if (Math.max(a.x, b.x) + EPSILON < Math.min(c.x, d.x)
      || Math.max(c.x, d.x) + EPSILON < Math.min(a.x, b.x)
      || Math.max(a.z, b.z) + EPSILON < Math.min(c.z, d.z)
      || Math.max(c.z, d.z) + EPSILON < Math.min(a.z, b.z)) return false;
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return abC * abD <= EPSILON && cdA * cdB <= EPSILON;
}
