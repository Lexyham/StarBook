(function () {
  const locations = [
    { city: 'Abuja', country: 'Nigeria', timezone: 'Africa/Lagos', airport: 'Nnamdi Azikiwe International Airport (ABV)' },
    { city: 'Accra', country: 'Ghana', timezone: 'Africa/Accra', airport: 'Kotoka International Airport (ACC)' },
    { city: 'Atlanta', country: 'United States', timezone: 'America/New_York', airport: 'Hartsfield-Jackson Atlanta International Airport (ATL)' },
    { city: 'Auckland', country: 'New Zealand', timezone: 'Pacific/Auckland', airport: 'Auckland Airport (AKL)' },
    { city: 'Berlin', country: 'Germany', timezone: 'Europe/Berlin', airport: 'Berlin Brandenburg Airport (BER)' },
    { city: 'Cape Town', country: 'South Africa', timezone: 'Africa/Johannesburg', airport: 'Cape Town International Airport (CPT)' },
    { city: 'Chicago', country: 'United States', timezone: 'America/Chicago', airport: "O'Hare International Airport (ORD)" },
    { city: 'Dallas', country: 'United States', timezone: 'America/Chicago', airport: 'Dallas Fort Worth International Airport (DFW)' },
    { city: 'Delhi', country: 'India', timezone: 'Asia/Kolkata', airport: 'Indira Gandhi International Airport (DEL)' },
    { city: 'Doha', country: 'Qatar', timezone: 'Asia/Qatar', airport: 'Hamad International Airport (DOH)' },
    { city: 'Dubai', country: 'United Arab Emirates', timezone: 'Asia/Dubai', airport: 'Dubai International Airport (DXB)' },
    { city: 'Dublin', country: 'Ireland', timezone: 'Europe/Dublin', airport: 'Dublin Airport (DUB)' },
    { city: 'Hong Kong', country: 'Hong Kong', timezone: 'Asia/Hong_Kong', airport: 'Hong Kong International Airport (HKG)' },
    { city: 'Istanbul', country: 'Turkey', timezone: 'Europe/Istanbul', airport: 'Istanbul Airport (IST)' },
    { city: 'Johannesburg', country: 'South Africa', timezone: 'Africa/Johannesburg', airport: 'O. R. Tambo International Airport (JNB)' },
    { city: 'Lagos', country: 'Nigeria', timezone: 'Africa/Lagos', airport: 'Murtala Muhammed International Airport (LOS)' },
    { city: 'London', country: 'United Kingdom', timezone: 'Europe/London', airport: 'Heathrow Airport (LHR)' },
    { city: 'Los Angeles', country: 'United States', timezone: 'America/Los_Angeles', airport: 'Los Angeles International Airport (LAX)' },
    { city: 'Madrid', country: 'Spain', timezone: 'Europe/Madrid', airport: 'Adolfo Suárez Madrid-Barajas Airport (MAD)' },
    { city: 'Manchester', country: 'United Kingdom', timezone: 'Europe/London', airport: 'Manchester Airport (MAN)' },
    { city: 'Melbourne', country: 'Australia', timezone: 'Australia/Melbourne', airport: 'Melbourne Airport (MEL)' },
    { city: 'Mexico City', country: 'Mexico', timezone: 'America/Mexico_City', airport: 'Mexico City International Airport (MEX)' },
    { city: 'Miami', country: 'United States', timezone: 'America/New_York', airport: 'Miami International Airport (MIA)' },
    { city: 'Mumbai', country: 'India', timezone: 'Asia/Kolkata', airport: 'Chhatrapati Shivaji Maharaj International Airport (BOM)' },
    { city: 'Nairobi', country: 'Kenya', timezone: 'Africa/Nairobi', airport: 'Jomo Kenyatta International Airport (NBO)' },
    { city: 'New York', country: 'United States', timezone: 'America/New_York', airport: 'John F. Kennedy International Airport (JFK)' },
    { city: 'Paris', country: 'France', timezone: 'Europe/Paris', airport: 'Charles de Gaulle Airport (CDG)' },
    { city: 'Rio de Janeiro', country: 'Brazil', timezone: 'America/Sao_Paulo', airport: 'Rio de Janeiro/Galeão International Airport (GIG)' },
    { city: 'Rome', country: 'Italy', timezone: 'Europe/Rome', airport: 'Leonardo da Vinci-Fiumicino Airport (FCO)' },
    { city: 'San Francisco', country: 'United States', timezone: 'America/Los_Angeles', airport: 'San Francisco International Airport (SFO)' },
    { city: 'Sao Paulo', country: 'Brazil', timezone: 'America/Sao_Paulo', airport: 'São Paulo/Guarulhos International Airport (GRU)' },
    { city: 'Seoul', country: 'South Korea', timezone: 'Asia/Seoul', airport: 'Incheon International Airport (ICN)' },
    { city: 'Singapore', country: 'Singapore', timezone: 'Asia/Singapore', airport: 'Singapore Changi Airport (SIN)' },
    { city: 'Sydney', country: 'Australia', timezone: 'Australia/Sydney', airport: 'Sydney Kingsford Smith Airport (SYD)' },
    { city: 'Tokyo', country: 'Japan', timezone: 'Asia/Tokyo', airport: 'Narita International Airport (NRT)' },
    { city: 'Toronto', country: 'Canada', timezone: 'America/Toronto', airport: 'Toronto Pearson International Airport (YYZ)' },
    { city: 'Vancouver', country: 'Canada', timezone: 'America/Vancouver', airport: 'Vancouver International Airport (YVR)' },
    { city: 'Washington', country: 'United States', timezone: 'America/New_York', airport: 'Dulles International Airport (IAD)' }
  ];
  const inputs = {
    city: document.getElementById('eventCity'),
    country: document.getElementById('eventCountry'),
    airport: document.getElementById('nearestAirport'),
    timezone: document.getElementById('eventTimezone')
  };
  if (Object.values(inputs).some(input => !input)) return;

  const lists = {
    city: document.getElementById('eventCityOptions'),
    country: document.getElementById('eventCountryOptions'),
    airport: document.getElementById('nearestAirportOptions'),
    timezone: document.getElementById('eventTimezoneOptions')
  };
  const normalize = value => value.trim().toLocaleLowerCase();
  const unique = values => [...new Set(values.filter(Boolean))];

  function countryNames() {
    const fallback = ['Australia', 'Brazil', 'Canada', 'France', 'Germany', 'Ghana', 'India', 'Ireland', 'Italy', 'Japan', 'Kenya', 'Mexico', 'New Zealand', 'Nigeria', 'Qatar', 'Singapore', 'South Africa', 'South Korea', 'Spain', 'Turkey', 'United Arab Emirates', 'United Kingdom', 'United States'];
    if (typeof Intl.DisplayNames !== 'function') return unique([...fallback, ...locations.map(location => location.country)]).sort();

    const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    const names = [];
    for (let first = 65; first <= 90; first += 1) {
      for (let second = 65; second <= 90; second += 1) {
        const code = String.fromCharCode(first, second);
        const name = displayNames.of(code);
        if (name && name.toUpperCase() !== code && name !== 'Unknown Region') names.push(name);
      }
    }
    return unique([...names, ...fallback]).sort((left, right) => left.localeCompare(right));
  }

  function setOptions(list, values, prefix = '') {
    const normalizedPrefix = normalize(prefix);
    const filteredValues = unique(values).filter(value =>
      !normalizedPrefix || normalize(value).startsWith(normalizedPrefix)
    );
    list.replaceChildren(...filteredValues.sort((left, right) => left.localeCompare(right)).map(value => {
      const option = document.createElement('option');
      option.value = value;
      return option;
    }));
  }

  function countryMatches(location) {
    const country = normalize(inputs.country.value);
    return !country || normalize(location.country) === country;
  }

  function refreshLocationOptions() {
    const hasCountryQuery = !!normalize(inputs.country.value);
    const matchingLocations = locations.filter(countryMatches);
    const availableLocations = matchingLocations.length ? matchingLocations : locations;
    const city = normalize(inputs.city.value);
    const hasCityQuery = !!city;
    const cityMatches = locations.filter(location =>
      countryMatches(location) && (!city || normalize(location.city).startsWith(city))
    );
    setOptions(lists.city, availableLocations.map(location => location.city), inputs.city.value);
    setOptions(lists.country, allCountryNames, inputs.country.value);
    setOptions(lists.airport, availableLocations.map(location => location.airport), inputs.airport.value);

    const browserTimezones = typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [];
    const timezoneMatches = hasCityQuery && cityMatches.length
      ? cityMatches
      : hasCountryQuery && matchingLocations.length ? matchingLocations : locations;
    const timezoneOptions = hasCityQuery || hasCountryQuery
      ? timezoneMatches.map(location => location.timezone)
      : browserTimezones.length ? browserTimezones : locations.map(location => location.timezone);
    setOptions(lists.timezone, timezoneOptions, inputs.timezone.value);
  }

  const allCountryNames = countryNames();
  Object.values(inputs).forEach(input => input.addEventListener('input', refreshLocationOptions));
  inputs.country.addEventListener('change', refreshLocationOptions);
  inputs.city.addEventListener('change', () => {
    const selectedCity = normalize(inputs.city.value);
    const location = locations.find(item => normalize(item.city) === selectedCity);
    if (!location) {
      refreshLocationOptions();
      return;
    }
    if (!inputs.country.value.trim()) inputs.country.value = location.country;
    if (!inputs.timezone.value.trim()) inputs.timezone.value = location.timezone;
    if (!inputs.airport.value.trim()) inputs.airport.value = location.airport;
    refreshLocationOptions();
  });

  refreshLocationOptions();
})();
