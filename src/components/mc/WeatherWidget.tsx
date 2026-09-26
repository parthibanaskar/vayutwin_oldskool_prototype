// @ts-nocheck
import { useEffect, useState, useRef } from "react";
import {
  Cloud,
  Sun,
  CloudRain,
  Wind,
  Droplets,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useMission } from "@/lib/twin/store";
import { cn } from "@/lib/utils";

export function WeatherWidget({ lat, lon }: { lat: number; lon: number }) {
  const [weather, setWeather] = useState<any>(null);
  const [expanded, setExpanded] = useState(false);
  const { dispatchWeatherAlert } = useMission();
  const alertSent = useRef(false);

  useEffect(() => {
    const fetchWeather = async () => {
      try {
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=temperature_2m,wind_speed_10m,weather_code,relative_humidity_2m&hourly=temperature_2m,weather_code,wind_speed_10m&timezone=auto`,
        );
        const data = await res.json();
        setWeather(data);

        // Check for severe weather in the next few hours
        if (!alertSent.current && data.hourly) {
          const upcomingWeather = data.hourly.weather_code.slice(0, 3);
          const upcomingWind = data.hourly.wind_speed_10m.slice(0, 3);
          const isRaining = upcomingWeather.some(
            (c: number) => c >= 51 && c <= 67,
          );
          const isWindy = upcomingWind.some((w: number) => w > 15);

          if (isRaining || isWindy) {
            alertSent.current = true;
            dispatchWeatherAlert({
              id: Math.random().toString(),
              key: "weatherAdvisory",
              subsystem: "nav",
              title: "Adverse Weather Predicted",
              severity: "advisory",
              confidence: 0.9,
              hotspot: "avionics",
              contributions: [],
              narrative: `ENVIRONMENTAL HAZARD: High ${isRaining ? "precipitation" : "wind"} detected in the operational area.\n\n• Location: Drone current coordinates.\n• Hazard: ${isRaining ? "Rain" : "High Winds"}.\n• Hardware Impact: Increased aerodynamic drag and sensor noise.\n• Action Required: Monitor structural icing and battery consumption.`,
              resolutionNarrative: `ACTION EXECUTED: Weather mitigation engaged.\n\n• Hardware Mitigation: Pitot heat activated. Flight controller gain adjusted for turbulent conditions.\n• Outcome: Flight envelope secured.`,
            });
          }
        }
      } catch (err) {
        console.error("Failed to fetch weather", err);
      }
    };

    fetchWeather();
    const interval = setInterval(fetchWeather, 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat.toFixed(2), lon.toFixed(2)]);

  if (!weather?.current) return null;

  const current = weather.current;
  const hourly = weather.hourly;

  const getWeatherIcon = (code: number) => {
    if (code === 0) return <Sun className="h-5 w-5 text-yellow-500" />;
    if (code <= 3) return <Cloud className="h-5 w-5 text-gray-400" />;
    if (code >= 51 && code <= 67)
      return <CloudRain className="h-5 w-5 text-blue-400" />;
    return <Cloud className="h-5 w-5 text-gray-400" />;
  };

  const getConditionText = (code: number) => {
    if (code === 0) return "Clear Sky";
    if (code === 1) return "Mainly Clear";
    if (code === 2) return "Partly Cloudy";
    if (code === 3) return "Overcast";
    if (code >= 51 && code <= 67) return "Rain";
    if (code >= 71) return "Snow";
    return "Cloudy";
  };

  return (
    <div className="panel-surface pointer-events-auto w-[16rem] flex flex-col">
      <div
        className="p-3 flex items-center justify-between gap-4 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div>
          <div className="flex items-center gap-1.5">
            <p className="label-xs text-muted-foreground uppercase">
              LOCAL WEATHER
            </p>
            {expanded ? (
              <ChevronUp className="w-3 h-3 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            {getWeatherIcon(current.weather_code)}
            <p className="font-mono text-lg leading-none">
              {current.temperature_2m}°C
            </p>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {getConditionText(current.weather_code)}
          </p>
        </div>

        <div className="flex flex-col gap-2 text-xs font-mono">
          <div className="flex items-center gap-2">
            <Wind className="w-3 h-3 text-muted-foreground" />
            <span>{current.wind_speed_10m} km/h</span>
          </div>
          <div className="flex items-center gap-2">
            <Droplets className="w-3 h-3 text-muted-foreground" />
            <span>{current.relative_humidity_2m}%</span>
          </div>
        </div>
      </div>

      {hourly && (
        <div
          className={cn(
            "border-t border-white/10 p-3 pt-2 transition-all",
            expanded ? "block" : "hidden",
          )}
        >
          <p className="label-xs text-muted-foreground uppercase mb-2">
            NEXT 3 HOURS
          </p>
          <div className="flex justify-between gap-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex flex-col items-center flex-1 bg-white/5 rounded p-1.5"
              >
                <span className="text-[0.65rem] text-muted-foreground mb-1">
                  +{i}h
                </span>
                {getWeatherIcon(hourly.weather_code[i])}
                <span className="text-xs mt-1 font-mono">
                  {hourly.temperature_2m[i]}°
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
