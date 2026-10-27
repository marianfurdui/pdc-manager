import { AppError } from "./errors.js";
import { fetchWithTimeout } from "./http.js";
import { addDays, localDate } from "./journal.js";

// Heating degree-days at a 15.5 °C base: how far each day's mean outdoor
// temperature fell below the point where a typical house needs heating.
// Dividing heating kWh by degree-days makes mild and cold months comparable.
export const HDD_BASE = 15.5;
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
// The archive lags a few days behind; the forecast API's past_days fills the gap.
const ARCHIVE_LAG_DAYS = 5;
const RECENT_DAYS = 10;
const HISTORY_YEARS = 2;

export function heatingDegrees(meanTemperature, base = HDD_BASE) {
  return Number.isFinite(meanTemperature) ? Math.max(0, base - meanTemperature) : 0;
}

export function monthlyDegreeDays(dailyMeans, base = HDD_BASE) {
  const months = {};
  for (const [date, mean] of Object.entries(dailyMeans || {})) {
    if (!Number.isFinite(mean)) continue;
    const month = date.slice(0, 7);
    months[month] ||= { hdd: 0, days: 0, mean: 0 };
    months[month].hdd += heatingDegrees(mean, base);
    months[month].mean += mean;
    months[month].days += 1;
  }
  for (const value of Object.values(months)) {
    value.hdd = Math.round(value.hdd * 10) / 10;
    value.mean = Math.round((value.mean / value.days) * 10) / 10;
  }
  return months;
}

export function daysInMonth(month) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

// Coordinates are rounded to 0.1° (about 10 km) before they leave the app.
export function roundCoordinate(value) {
  return Math.round(Number(value) * 10) / 10;
}

async function fetchDailyMeans(url, fetchImpl) {
  const response = await fetchImpl(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new AppError(payload.reason || `Open-Meteo returned ${response.status}`, 502, "WEATHER_UNAVAILABLE");
  const dates = payload.daily?.time || [];
  const means = payload.daily?.temperature_2m_mean || [];
  return Object.fromEntries(dates.map((date, index) => [date, means[index]]).filter(([, mean]) => Number.isFinite(mean)));
}

function weatherUrl(base, params) {
  const url = new URL(base);
  url.search = new URLSearchParams({ daily: "temperature_2m_mean", timezone: "auto", ...params }).toString();
  return url.toString();
}

// Fills journal.weather with daily mean temperatures from the start of
// the same month two years ago, matching ONECTA's 24-month history. Past
// days are fetched once; recent days at most once per day.
// Returns true when the journal changed and needs saving.
export async function ensureWeather(journal, { latitude, longitude, timeZone }, { now = new Date(), fetchImpl = (url) => fetchWithTimeout(url, {}, 15_000) } = {}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  const lat = roundCoordinate(latitude);
  const lon = roundCoordinate(longitude);
  const key = `${lat},${lon}`;
  const today = localDate(now, timeZone);
  if (journal.weather?.key !== key) journal.weather = { key, daily: {}, fetchedOn: null };
  const weather = journal.weather;
  if (weather.fetchedOn === today) return false;

  const start = `${Number(today.slice(0, 4)) - HISTORY_YEARS}-${today.slice(5, 7)}-01`;
  const archiveEnd = addDays(today, -ARCHIVE_LAG_DAYS);
  const known = Object.keys(weather.daily).sort();
  const archiveStart = known.length ? addDays(known.at(-1), -RECENT_DAYS) : start;
  const coordinates = { latitude: String(lat), longitude: String(lon) };
  const fetched = [];
  if (archiveStart <= archiveEnd) {
    fetched.push(await fetchDailyMeans(weatherUrl(ARCHIVE_URL, { ...coordinates, start_date: archiveStart < start ? start : archiveStart, end_date: archiveEnd }), fetchImpl));
  }
  fetched.push(await fetchDailyMeans(weatherUrl(FORECAST_URL, { ...coordinates, past_days: String(RECENT_DAYS), forecast_days: "1" }), fetchImpl));
  // Today's mean is still moving, so only finished days are kept.
  for (const means of fetched) for (const [date, mean] of Object.entries(means)) if (date < today) weather.daily[date] = mean;
  for (const date of Object.keys(weather.daily)) if (date < start) delete weather.daily[date];
  weather.fetchedOn = today;
  return true;
}
