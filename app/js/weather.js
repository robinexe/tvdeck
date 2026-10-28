/*
 * Current weather from Open-Meteo (free, no API key, no tracking).
 * Results are cached for 30 minutes.
 */
var Weather = (function () {
  'use strict';

  var CACHE_KEY = 'tvdeck:weather';
  var TTL_MS = 30 * 60 * 1000;

  // WMO weather codes -> [label, glyph]
  var CODES = {
    0: ['Céu limpo', '☀'], 1: ['Poucas nuvens', '🌤'], 2: ['Parcialmente nublado', '⛅'], 3: ['Nublado', '☁'],
    45: ['Neblina', '🌫'], 48: ['Neblina', '🌫'],
    51: ['Garoa', '🌦'], 53: ['Garoa', '🌦'], 55: ['Garoa', '🌦'],
    61: ['Chuva', '🌧'], 63: ['Chuva', '🌧'], 65: ['Chuva forte', '🌧'],
    71: ['Neve', '🌨'], 73: ['Neve', '🌨'], 75: ['Neve forte', '🌨'],
    80: ['Pancadas de chuva', '🌦'], 81: ['Pancadas de chuva', '🌦'], 82: ['Pancadas fortes', '⛈'],
    95: ['Trovoadas', '⛈'], 96: ['Trovoadas', '⛈'], 99: ['Trovoadas', '⛈']
  };

  function getJSON(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function readCache(city) {
    try {
      var cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (cached && cached.city === city && Date.now() - cached.at < TTL_MS) return cached.data;
    } catch (e) { /* ignore */ }
    return null;
  }

  function writeCache(city, data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ city: city, at: Date.now(), data: data }));
    } catch (e) { /* ignore */ }
  }

  function fetchCurrent(city) {
    var cached = readCache(city);
    if (cached) return Promise.resolve(cached);

    var geoUrl = 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=pt&name=' + encodeURIComponent(city);
    return getJSON(geoUrl).then(function (geo) {
      if (!geo.results || !geo.results.length) throw new Error('Cidade não encontrada');
      var place = geo.results[0];
      var url = 'https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto' +
        '&latitude=' + place.latitude + '&longitude=' + place.longitude;
      return getJSON(url).then(function (forecast) {
        var code = forecast.current.weather_code;
        var info = CODES[code] || ['', '🌡'];
        var data = {
          place: place.name,
          temp: Math.round(forecast.current.temperature_2m),
          max: forecast.daily ? Math.round(forecast.daily.temperature_2m_max[0]) : null,
          min: forecast.daily ? Math.round(forecast.daily.temperature_2m_min[0]) : null,
          wind: forecast.current.wind_speed_10m != null ? Math.round(forecast.current.wind_speed_10m) : null,
          label: info[0],
          glyph: info[1]
        };
        writeCache(city, data);
        return data;
      });
    });
  }

  return { fetchCurrent: fetchCurrent };
})();
