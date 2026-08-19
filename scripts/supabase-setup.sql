-- Supabase SQL Editor에 붙여넣고 실행하세요.
-- 여러 사람이 공유하는 "찜"/"진행 관리(진행중·완료·제외)" 상태를 저장하는 테이블입니다.
create table if not exists policy_state (
  policy_id text primary key,
  starred boolean not null default false,
  app_status text check (app_status in ('in_progress','done','excluded')),
  updated_at timestamptz not null default now()
);

-- 로그인 없이 누구나 읽고 쓸 수 있도록 허용합니다 (사용자 요청: "지금처럼 누구나 수정 가능").
alter table policy_state enable row level security;

create policy "public read" on policy_state
  for select using (true);

create policy "public insert" on policy_state
  for insert with check (true);

create policy "public update" on policy_state
  for update using (true) with check (true);

-- 한 사람이 바꾼 내용이 다른 사람 화면에도 실시간으로 반영되게 합니다.
alter publication supabase_realtime add table policy_state;

-- 2026-08-19 추가: 진행중/완료 사업에 담당자를 지정하는 기능용 컬럼.
alter table policy_state add column if not exists assignee text;

-- 2026-08-19 추가: "제외" 탭에 제외한 사람/사유를 기록하는 기능용 컬럼.
alter table policy_state add column if not exists excluded_by text;
alter table policy_state add column if not exists excluded_reason text;
