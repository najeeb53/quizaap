import os

files = {
    'src/app/admin/layout.tsx': '''export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-slate-900 text-white p-4 shadow-md">
        <h1 className="text-xl font-bold">Quiz Admin Dashboard</h1>
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}''',
    'src/app/admin/page.tsx': '''export default function AdminPage() {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Dashboard Overview</h2>
      <p>Manage quizzes, question banks, and events from here.</p>
    </div>
  );
}''',
    'src/app/host/[sessionId]/layout.tsx': '''export default function HostLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <header className="bg-black p-4 border-b border-gray-800 flex justify-between items-center">
        <h1 className="text-xl font-bold text-red-500">LIVE Control Room</h1>
        <div className="text-sm text-gray-400">Host Mode</div>
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}''',
    'src/app/host/[sessionId]/page.tsx': '''export default async function HostPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = (await params);
  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Live Session: {sessionId}</h2>
      <p>Use the controls here to run the quiz.</p>
    </div>
  );
}''',
    'src/app/display/[sessionId]/layout.tsx': '''export default function DisplayLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center overflow-hidden">
      {children}
    </div>
  );
}''',
    'src/app/display/[sessionId]/page.tsx': '''export default async function DisplayPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = (await params);
  return (
    <div className="text-center">
      <h1 className="text-6xl font-bold mb-4">Live Quiz Projector</h1>
      <p className="text-2xl text-gray-400">Session ID: {sessionId}</p>
    </div>
  );
}''',
    'src/app/team/[teamCode]/layout.tsx': '''export default function TeamLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-blue-50">
      <header className="bg-blue-600 text-white p-4 shadow-md text-center">
        <h1 className="text-xl font-bold">Team Participant Panel</h1>
      </header>
      <main className="p-4">{children}</main>
    </div>
  );
}''',
    'src/app/team/[teamCode]/page.tsx': '''export default async function TeamPage({ params }: { params: Promise<{ teamCode: string }> }) {
  const { teamCode } = (await params);
  return (
    <div className="text-center">
      <h2 className="text-2xl font-bold mb-4 text-blue-900">Welcome, Team {teamCode}!</h2>
      <p className="text-gray-700">Waiting for the host to start the quiz...</p>
    </div>
  );
}'''
}

for path, content in files.items():
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
