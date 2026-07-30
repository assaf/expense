import { useEffect, useRef, useState } from "react";
import type LType from "leaflet";

interface MapViewProps {
  /** Polyline coordinates as [lat, lng] pairs. */
  coords: [number, number][];
  /** Waypoints to mark, in route order. */
  stops?: { lat: number; lng: number; label?: string }[];
  height?: number | string;
  interactive?: boolean;
  className?: string;
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
  stops = [],
  height = 160,
  interactive = false,
  className,
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
      attributionControl: false,
    });
    mapRef.current = map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
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
      if (layer instanceof L.Polyline || layer instanceof L.Marker) {
        map.removeLayer(layer);
      }
    });

    const allPoints: [number, number][] = [];
    for (const stop of stops) {
      const marker = L.circleMarker([stop.lat, stop.lng], {
        radius: 5,
        color: "#111827",
        fillColor: "#fbbf24",
        fillOpacity: 1,
      }).addTo(map);
      if (stop.label) marker.bindTooltip(stop.label, { direction: "top" });
      allPoints.push([stop.lat, stop.lng]);
    }

    if (coords.length >= 2) {
      L.polyline(coords, { color: "#2563eb", weight: 3, opacity: 0.8 }).addTo(
        map,
      );
      allPoints.push(...coords);
    }

    if (allPoints.length > 0) {
      map.fitBounds(L.latLngBounds(allPoints).pad(0.2), { animate: false });
    } else {
      map.setView([37.0902, -95.7129], 4);
    }
  }, [L, coords, stops]);

  return (
    <div
      ref={ref}
      className={className}
      style={{ height: typeof height === "number" ? `${height}px` : height }}
    />
  );
}
