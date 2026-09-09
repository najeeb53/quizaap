import Link from "next/link";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <header className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between shadow-md">
        <h1 className="text-xl font-bold">🛠️ Quiz Admin</h1>
        <nav className="flex gap-6 text-sm font-medium">
          <Link href="/admin" className="hover:text-blue-300 transition">Dashboard</Link>
          <Link href="/admin/quizzes" className="hover:text-blue-300 transition">Quizzes</Link>
          <Link href="/admin/question-bank" className="hover:text-blue-300 transition">Question Bank</Link>
        </nav>
        <Link href="/" className="text-xs text-slate-400 hover:text-white transition">← Home</Link>
      </header>
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">{children}</main>
    </div>
  );
}
