import Link from "next/link";

export default function AdminPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-3">Quiz Administration</h1>
          <p className="text-lg text-gray-700">Manage quizzes, questions, and live sessions all in one place.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <Link href="/admin/quizzes"
            className="group block bg-gradient-to-br from-blue-50 to-blue-100 rounded-2xl border-2 border-blue-200 p-8 hover:shadow-xl hover:border-blue-300 transition-all duration-300 transform hover:-translate-y-1">
            <div className="flex items-center gap-4 mb-4">
              <div className="text-5xl">🏆</div>
              <div className="flex-1">
                <h3 className="font-bold text-2xl text-gray-900">Quizzes</h3>
                <p className="text-sm text-blue-700 font-semibold mt-1">Manage your quiz events</p>
              </div>
            </div>
            <p className="text-gray-800 mt-4">Create and customize quizzes, build structured rounds, manage team registrations, and run live scoring sessions with real-time updates.</p>
            <div className="mt-6 flex items-center text-blue-600 font-semibold group-hover:gap-2 transition-all">
              Get Started <span className="ml-2 text-xl group-hover:translate-x-1 transition-transform">→</span>
            </div>
          </Link>

          <Link href="/admin/question-bank"
            className="group block bg-gradient-to-br from-purple-50 to-purple-100 rounded-2xl border-2 border-purple-200 p-8 hover:shadow-xl hover:border-purple-300 transition-all duration-300 transform hover:-translate-y-1">
            <div className="flex items-center gap-4 mb-4">
              <div className="text-5xl">📚</div>
              <div className="flex-1">
                <h3 className="font-bold text-2xl text-gray-900">Question Bank</h3>
                <p className="text-sm text-purple-700 font-semibold mt-1">Curate your questions</p>
              </div>
            </div>
            <p className="text-gray-800 mt-4">Build and organize your question library with multiple-choice, picture, and sequencing questions. Import questions in bulk via CSV and categorize by difficulty.</p>
            <div className="mt-6 flex items-center text-purple-600 font-semibold group-hover:gap-2 transition-all">
              Get Started <span className="ml-2 text-xl group-hover:translate-x-1 transition-transform">→</span>
            </div>
          </Link>
        </div>

        <div className="mt-16 bg-white rounded-2xl border border-gray-200 shadow-lg p-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Quick Start</h2>
          <ol className="space-y-3 text-gray-800">
            <li className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white font-bold flex-shrink-0">1</span>
              <span><strong>Build Your Question Bank</strong> — Add questions with multiple difficulty levels and categories</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white font-bold flex-shrink-0">2</span>
              <span><strong>Create a Quiz</strong> — Set up a new quiz event with details like date, teams, and duration</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white font-bold flex-shrink-0">3</span>
              <span><strong>Configure Rounds</strong> — Define each round with question types, scoring rules, and buzzer settings</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white font-bold flex-shrink-0">4</span>
              <span><strong>Add Teams</strong> — Register teams and generate access codes and PINs</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white font-bold flex-shrink-0">5</span>
              <span><strong>Go Live</strong> — Run the quiz with real-time scoring and a projector display</span>
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}
