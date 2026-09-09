import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-600 via-blue-500 to-purple-600 flex flex-col items-center justify-center gap-12 text-white font-sans">
      <div className="text-center">
        <h1 className="text-6xl font-black tracking-tight mb-4">🎯 Live Quiz Show</h1>
        <p className="text-xl text-blue-100">Interactive quiz competition platform with real-time scoring, buzzer rounds, and team play</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 w-full max-w-4xl px-6">
        <Link href="/admin"
          className="group flex flex-col items-center gap-4 bg-white/20 backdrop-blur-sm hover:bg-white/30 border-2 border-white/30 hover:border-white/50 rounded-2xl p-8 transition-all duration-300 transform hover:scale-105 hover:shadow-2xl">
          <div className="relative">
            <div className="absolute inset-0 bg-blue-400 rounded-2xl blur opacity-50 group-hover:opacity-75 transition group-hover:scale-110"></div>
            <span className="relative text-5xl">🛠️</span>
          </div>
          <span className="font-bold text-2xl text-white">Admin</span>
          <span className="text-sm text-blue-50 text-center leading-relaxed">Create quizzes, manage questions, configure rounds, and run live sessions</span>
        </Link>

        <Link href="/host"
          className="group flex flex-col items-center gap-4 bg-white/20 backdrop-blur-sm hover:bg-white/30 border-2 border-white/30 hover:border-white/50 rounded-2xl p-8 transition-all duration-300 transform hover:scale-105 hover:shadow-2xl">
          <div className="relative">
            <div className="absolute inset-0 bg-purple-400 rounded-2xl blur opacity-50 group-hover:opacity-75 transition group-hover:scale-110"></div>
            <span className="relative text-5xl">🎙️</span>
          </div>
          <span className="font-bold text-2xl text-white">Host</span>
          <span className="text-sm text-blue-50 text-center leading-relaxed">Control the quiz flow, reveal answers, and manage scoring</span>
        </Link>

        <Link href="/team"
          className="group flex flex-col items-center gap-4 bg-white/20 backdrop-blur-sm hover:bg-white/30 border-2 border-white/30 hover:border-white/50 rounded-2xl p-8 transition-all duration-300 transform hover:scale-105 hover:shadow-2xl">
          <div className="relative">
            <div className="absolute inset-0 bg-orange-400 rounded-2xl blur opacity-50 group-hover:opacity-75 transition group-hover:scale-110"></div>
            <span className="relative text-5xl">🔔</span>
          </div>
          <span className="font-bold text-2xl text-white">Team</span>
          <span className="text-sm text-blue-50 text-center leading-relaxed">Answer questions, buzz in, and compete with other teams</span>
        </Link>
      </div>

      <div className="mt-8 text-center">
        <p className="text-blue-100 text-sm">
          Built for interactive quiz shows, competitions, and classroom engagement
        </p>
      </div>
    </div>
  );
}
