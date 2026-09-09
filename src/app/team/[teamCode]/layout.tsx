export default function TeamLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-blue-50">
      <header className="bg-blue-600 text-white p-4 shadow-md text-center">
        <h1 className="text-xl font-bold">Team Participant Panel</h1>
      </header>
      <main className="p-4">{children}</main>
    </div>
  );
}