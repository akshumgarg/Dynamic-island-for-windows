const { net } = require('electron')
const { CITY } = require('./config')

async function getJson(url) {
  const res = await net.fetch(url)
  return res.json()
}

// Finds the city and its position on the map
async function findPlace() {
  if (CITY) {
    const data = await getJson('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(CITY))
    const place = data.results[0]
    return { city: place.name, lat: place.latitude, lon: place.longitude }
  }
  const data = await getJson('https://ipwho.is/')
  return { city: data.city, lat: data.latitude, lon: data.longitude }
}

// Asks Open-Meteo (a free weather website, no sign-up) for the weather now
async function getWeather() {
  const place = await findPlace()
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + place.lat + '&longitude=' + place.lon +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m'
  const now = (await getJson(url)).current
  return {
    city: place.city, lat: place.lat, lon: place.lon,
    temp: Math.round(now.temperature_2m),
    feels: Math.round(now.apparent_temperature),
    humidity: now.relative_humidity_2m,
    wind: Math.round(now.wind_speed_10m),
    code: now.weather_code
  }
}

module.exports = { getWeather }
