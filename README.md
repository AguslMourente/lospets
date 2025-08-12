# LostPets

Web + API para reportar mascotas perdidas y ver avisos cercanos.

**Stack**
- Node.js + Express
- PostgreSQL
- JWT auth
- Cloudinary (imágenes) *(opcional)*
- Algolia (búsqueda por cercanía) *(opcional)*
- Resend (emails) *(opcional)*
- Frontend estático en `public/`

## Correr local

```bash
npm i
createdb lostpets_db
psql -d lostpets_db -f server/schema.sql
cp .env.example .env   # completar variables
npm run dev
