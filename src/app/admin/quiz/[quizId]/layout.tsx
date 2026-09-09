'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

export default function QuizLayout({ children }: { children: React.ReactNode }) {
  const { quizId } = useParams<{ quizId: string }>();
  const pathname = usePathname();
  const [quizName, setQuizName] = useState<string>('');

  useEffect(() => {
    supabase.from('quizzes').select('name').eq('id', quizId).single().then(({ data }) => {
      if (data) setQuizName(data.name);
    });
  }, [quizId]);

  const tabs = [
    { href: `/admin/quiz/${quizId}/rounds`, label: 'Rounds' },
    { href: `/admin/quiz/${quizId}/teams`, label: 'Teams' },
    { href: `/admin/quiz/${quizId}/live`, label: 'Live' },
    { href: `/admin/quiz/${quizId}/results`, label: 'Results & Audit' },
  ];

  return (
    <div>
      <div className="mb-6">
        <Link href="/admin/quizzes" className="text-sm text-blue-600 hover:underline">← All Quizzes</Link>
        <h2 className="text-2xl font-bold mt-1">{quizName || 'Quiz'}</h2>
        <div className="flex gap-1 mt-4 border-b border-gray-200">
          {tabs.map(tab => (
            <Link key={tab.href} href={tab.href}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                pathname === tab.href
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}>
              {tab.label}
            </Link>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}
