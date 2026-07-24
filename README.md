# Grocery Planner

Personal deals-first weekly meal planner for Baltimore (21224).

## Setup

1. Copy `.env.local.example` to `.env.local` and fill in values.
2. Create a Supabase project and apply `supabase/migrations/0001_initial_schema.sql`.
3. Register a Kroger developer app at developer.kroger.com; add credentials to `.env.local`.
4. Install and run:

   ```bash
   npm install
   npm run seed        # seeds canonical ingredients
   npm run dev
   ```

## Deploy

Push to GitHub, then import the repo in Vercel. Set all env vars from `.env.local` in Vercel project settings.
