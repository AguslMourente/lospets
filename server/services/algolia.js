// server/services/algolia.js
require("dotenv").config();
const algoliasearch = require("algoliasearch"); // v4

function hasCreds() {
  return !!(process.env.ALGOLIA_APP_ID && process.env.ALGOLIA_ADMIN_KEY);
}

let index = null;

if (hasCreds()) {
  const client = algoliasearch(
    process.env.ALGOLIA_APP_ID,
    process.env.ALGOLIA_ADMIN_KEY
  );
  index = client.initIndex(process.env.ALGOLIA_INDEX || "pets");
}

async function indexPet(pet) {
  if (!index) return;
  const obj = {
    objectID: String(pet.id),
    name: pet.name,
    status: pet.status,
    location: pet.location,
    image_url: pet.image_url || pet.imageUrl || undefined,
    _geoloc:
      pet.lat != null && pet.lng != null
        ? { lat: Number(pet.lat), lng: Number(pet.lng) }
        : undefined,
  };
  await index.saveObject(obj);
}

async function deletePet(id) {
  if (!index) return;
  await index.deleteObject(String(id));
}

async function searchNearby(lat, lng, radiusMeters = 3000) {
  if (!index) return { hits: [] };
  return index.search("", {
    aroundLatLng: `${lat}, ${lng}`,
    aroundRadius: radiusMeters,
    filters: "status:lost",
  });
}

module.exports = { indexPet, deletePet, searchNearby };
