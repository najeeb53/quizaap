export default function HostLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-black p-4 border-b border-gray-800 flex justify-between items-center">
        <h1 className="text-xl font-bold text-red-500">LIVE Control Room</h1>
        <div className="text-sm text-gray-400">Host Mode</div>
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}