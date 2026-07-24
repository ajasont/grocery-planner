import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Grocery Planner',
  description: 'Deals-first weekly meal planner',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900 antialiased">
        <div className="mx-auto max-w-2xl p-4">
          <header className="mb-6 flex items-center justify-between">
            <h1 className="text-xl font-semibold">Grocery Planner</h1>
            <form action="/api/auth/logout" method="POST">
              <button type="submit" className="text-sm text-neutral-500 hover:underline">
                Log out
              </button>
            </form>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
