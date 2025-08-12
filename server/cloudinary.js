// server/cloudinary.js
require("dotenv").config();
const cloudinary = require("cloudinary").v2;

const hasCreds =
  !!process.env.CLOUDINARY_CLOUD_NAME &&
  !!process.env.CLOUDINARY_API_KEY &&
  !!process.env.CLOUDINARY_API_SECRET;

if (hasCreds) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

async function uploadDataURI(dataURI) {
  if (!hasCreds || !dataURI) return null;
  const res = await cloudinary.uploader.upload(dataURI, {
    folder: "lostpets",
    resource_type: "image",
  });
  return res.secure_url;
}

module.exports = { uploadDataURI };
