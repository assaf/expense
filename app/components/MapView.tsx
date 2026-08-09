import { useEffect, useRef, useState } from "react";
import type LType from "leaflet";

interface MapViewProps {
  /** Polyline coordinates as [lat, lng] pairs — the outbound route. */
  coords: [number, number][];
  /** Return leg (last stop → start), drawn as a gray dashed line under
   *  the route. */
  returnCoords?: [number, number][];
  /** Waypoints to mark, in route order. */
  stops?: {
    lat: number;
    lng: number;
    label?: string;
    tooltip?: string;
    /** Bubble label — "S", "1", "2" … Rendered as HTML by the divIcon,
     *  so the caller must pass digits/S only. */
    number?: string;
  }[];
  /** Render the stop markers (default true); small thumbnails pass false. */
  showStops?: boolean;
  /** Route stroke width: "normal" (8/4 casing/line) or "thin" (3/1.5) for small thumbnails. */
  lineWidth?: "normal" | "thin";
  height?: number | string;
  interactive?: boolean;
  className?: string;
  /** Accessible label for the map container (screen readers). */
  ariaLabel?: string;
}

type Leaflet = typeof LType;

/**
 * Leaflet map showing a route polyline and stop markers.
 *
 * Leaflet touches `navigator`/`document` at module load, so it is imported
 * dynamically (client-only) and never enters the SSR bundle.
 */
export default function MapView({
  coords,
  returnCoords = [],
  stops = [],
  showStops = true,
  lineWidth = "normal",
  height = 160,
  interactive = false,
  className,
  ariaLabel,
}: MapViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LType.Map | null>(null);
  const [L, setL] = useState<Leaflet | null>(null);

  // Load Leaflet in the browser only.
  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((mod) => {
      if (!cancelled) setL(mod.default);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Create the map once Leaflet is ready.
  useEffect(() => {
    if (!L || !ref.current || mapRef.current) return;
    const map = L.map(ref.current, {
      dragging: interactive,
      scrollWheelZoom: interactive,
      doubleClickZoom: interactive,
      boxZoom: interactive,
      keyboard: interactive,
      zoomControl: interactive,
      // Attribution is required by the tile providers; the tiny list
      // thumbnails skip it (it would be unreadable at 56px).
      attributionControl: interactive,
    });
    mapRef.current = map;
    // Carto Positron "light": a minimal basemap (light gray streets, no
    // POI noise) so the route and markers stand out instead of competing
    // with a busy street map.
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [L, interactive]);

  // Draw the route + markers whenever inputs change.
  useEffect(() => {
    const map = mapRef.current;
    if (!L || !map) return;

    map.eachLayer((layer) => {
      // Any drawn layer from a previous pass (return leg, route casing,
      // blue line, stop markers) is replaced; the tile layer is a
      // TileLayer and stays.
      if (!(layer instanceof L.TileLayer)) {
        map.removeLayer(layer);
      }
    });

    // Return leg first (under the route), then the route casing + blue
    // line, then the stop markers on top — a marker sitting on the line
    // stays hoverable (and its tooltip reachable) instead of being covered
    // by the casing.
    const allPoints: [number, number][] = [];
    const lineWeight = lineWidth === "thin" ? 1.5 : 4;
    if (returnCoords.length >= 2) {
      // The dashed gray return leg reads as "driven, but the way back" —
      // visually lighter than the measured outbound route.
      L.polyline(returnCoords, {
        color: "#6b7280",
        weight: lineWeight,
        opacity: 1,
        dashArray: "6 6",
        lineJoin: "round",
        lineCap: "round",
      }).addTo(map);
      allPoints.push(...returnCoords);
    }
    if (coords.length >= 2) {
      const casingWeight = lineWidth === "thin" ? 3 : 8;
      // A white casing under the blue line keeps the route readable over
      // any background — it reads as one bold path instead of a thin line
      // that blends into the street grid.
      L.polyline(coords, {
        color: "#ffffff",
        weight: casingWeight,
        opacity: 0.95,
        lineJoin: "round",
        lineCap: "round",
      }).addTo(map);
      L.polyline(coords, {
        color: "#2563eb",
        weight: lineWeight,
        opacity: 1,
        lineJoin: "round",
        lineCap: "round",
      }).addTo(map);
      allPoints.push(...coords);
    }

    if (showStops) {
      for (const stop of stops) {
        // A generous invisible hit area is the real hover target — it makes
        // the stops easy to point at. The visible marker (numbered bubble,
        // or plain amber dot) is drawn on top as a non-interactive layer:
        // Leaflet hit-tests by geometry, so the small marker never blocks a
        // hover and the tooltip (bound to the invisible circle) opens
        // anywhere within ~14px of the stop.
        const hit = L.circleMarker([stop.lat, stop.lng], {
          radius: 14,
          stroke: false,
          fillColor: "#000000",
          fillOpacity: 0,
          interactive: true,
        }).addTo(map);
        // Leaflet renders string tooltip content as HTML, so dynamic text
        // (addresses) must arrive pre-escaped from the caller.
        const tip = stop.tooltip ?? stop.label;
        if (tip) hit.bindTooltip(tip, { direction: "top" });
        if (stop.number !== undefined) {
          // Numbered bubble (S, 1, 2, …) — replaces the plain dot so each
          // stop is identifiable on a busy route. The label is caller-
          // generated (digits/S) and rendered as HTML by the divIcon.
          L.marker([stop.lat, stop.lng], {
            icon: L.divIcon({
              className: "map-stop-bubble",
              html: `<span>${stop.number}</span>`,
              iconSize: [20, 20],
              iconAnchor: [10, 10],
            }),
            interactive: false,
          }).addTo(map);
        } else {
          L.circleMarker([stop.lat, stop.lng], {
            radius: 7,
            color: "#111827",
            fillColor: "#fbbf24",
            fillOpacity: 1,
            interactive: false,
          }).addTo(map);
        }
        allPoints.push([stop.lat, stop.lng]);
      }
    }

    if (allPoints.length > 0) {
      map.fitBounds(L.latLngBounds(allPoints).pad(0.2), { animate: false });
    } else {
      map.setView([37.0902, -95.7129], 4);
    }
  }, [L, coords, returnCoords, stops]);

  return (
    <div
      ref={ref}
      className={className}
      aria-label={ariaLabel}
      role="img"
      style={{ height: typeof height === "number" ? `${height}px` : height }}
    />
  );
}
