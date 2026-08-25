-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.materials (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  description text,
  price_unit numeric NOT NULL,
  unit text NOT NULL,
  category text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT materials_pkey PRIMARY KEY (id)
);
CREATE TABLE public.services (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  description text,
  price_per_m2 numeric,
  category text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT services_pkey PRIMARY KEY (id)
);
CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  phone_number text NOT NULL UNIQUE,
  display_name text,
  metadata jsonb DEFAULT '{}'::jsonb,
  store_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);
CREATE TABLE public.chats (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  status text DEFAULT 'active'::text,
  tags ARRAY DEFAULT '{}'::text[],
  metadata jsonb DEFAULT '{}'::jsonb,
  store_id uuid,
  last_message_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  is_ai_paused boolean DEFAULT false,
  last_message_preview text,
  unread_count integer DEFAULT 0,
  CONSTRAINT chats_pkey PRIMARY KEY (id),
  CONSTRAINT chats_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  chat_id uuid,
  user_id uuid,
  role text NOT NULL CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])),
  content text NOT NULL,
  message_sid text,
  status text DEFAULT 'sent'::text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT messages_pkey PRIMARY KEY (id),
  CONSTRAINT messages_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.chats(id),
  CONSTRAINT messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.projects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  chat_id uuid,
  total_area_m2 numeric,
  budget_total numeric,
  is_viable boolean,
  status text DEFAULT 'en_cotizacion'::text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT projects_pkey PRIMARY KEY (id),
  CONSTRAINT projects_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.chats(id)
);
CREATE TABLE public.payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid,
  amount numeric NOT NULL,
  evidence_url text,
  status text DEFAULT 'pendiente'::text,
  payment_type text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT payments_pkey PRIMARY KEY (id),
  CONSTRAINT payments_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.checkpoints (
  thread_id text NOT NULL,
  checkpoint_id text NOT NULL,
  parent_id text,
  checkpoint jsonb NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT checkpoints_pkey PRIMARY KEY (thread_id, checkpoint_id)
);
CREATE TABLE public.profiles (
  id uuid NOT NULL,
  full_name text,
  email text NOT NULL UNIQUE,
  role text DEFAULT 'admin'::text,
  avatar_url text,
  updated_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id)
);