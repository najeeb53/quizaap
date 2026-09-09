-- SQL Schema for Live Quiz Show Software

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'event_admin', 'quiz_master', 'scorekeeper')),
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Quizzes
CREATE TABLE quizzes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  edition TEXT,
  event_date TIMESTAMP WITH TIME ZONE,
  duration_minutes INTEGER,
  status TEXT DEFAULT 'draft',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Rounds
CREATE TABLE rounds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_id UUID REFERENCES quizzes(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  round_type TEXT NOT NULL,
  question_count INTEGER DEFAULT 0,
  settings_json JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active'
);

-- Categories
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active'
);

-- Questions
CREATE TABLE questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  difficulty TEXT,
  answer TEXT,
  explanation TEXT,
  media_url TEXT,
  metadata_json JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active'
);

-- Question Options
CREATE TABLE question_options (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
  option_key TEXT NOT NULL,
  option_text TEXT NOT NULL,
  media_url TEXT,
  sort_order INTEGER DEFAULT 0
);

-- Round Questions (Selected for a round)
CREATE TABLE round_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  round_id UUID REFERENCES rounds(id) ON DELETE CASCADE,
  question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL,
  marks_correct INTEGER DEFAULT 10,
  marks_wrong INTEGER DEFAULT 0,
  marks_skip INTEGER DEFAULT 0,
  locked BOOLEAN DEFAULT false
);

-- Teams
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_id UUID REFERENCES quizzes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  pin_hash TEXT NOT NULL,
  logo_url TEXT,
  status TEXT DEFAULT 'active',
  eliminated_at TIMESTAMP WITH TIME ZONE
);

-- Live Sessions
CREATE TABLE live_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_id UUID REFERENCES quizzes(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'not_started',
  current_round_id UUID REFERENCES rounds(id),
  current_round_question_id UUID REFERENCES round_questions(id),
  display_state TEXT DEFAULT 'idle',
  timer_state JSONB DEFAULT '{}',
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE
);

-- Answers
CREATE TABLE answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
  round_question_id UUID REFERENCES round_questions(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  answer_json JSONB NOT NULL,
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
  locked_at TIMESTAMP WITH TIME ZONE,
  is_correct BOOLEAN,
  awarded_marks INTEGER
);

-- Buzzer Events
CREATE TABLE buzzer_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
  round_question_id UUID REFERENCES round_questions(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  buzzed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
  position INTEGER,
  status TEXT DEFAULT 'pending',
  penalty_marks INTEGER DEFAULT 0
);

-- Scores (Immutable Transactions)
CREATE TABLE scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  round_id UUID REFERENCES rounds(id),
  points INTEGER NOT NULL,
  reason TEXT,
  source TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);
