const DEFAULT_SUPABASE_URL = 'https://afilbolhlkiingnsupgr.supabase.co';
const DEFAULT_SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmaWxib2xobGtpaW5nbnN1cGdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTIzOTIsImV4cCI6MjA4OTE2ODM5Mn0.8TBfHfRB0vEyKPMWBd6i1DNwx1nS9UqprIAsJf35n88';

async function createSupabaseAuthedClient(accessToken) {
  const SUPABASE_URL = process.env.SWITCHMAN_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
  const SUPABASE_ANON = process.env.SWITCHMAN_SUPABASE_ANON ?? DEFAULT_SUPABASE_ANON;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export function registerAccountCommands(program, {
  chalk,
  checkLicence,
  clearCredentials,
  getPendingQueueStatus,
  getRepo,
  loginWithGitHub,
  ora,
  PRO_PAGE_URL,
  readCredentials,
}) {
  program
    .command('login')
    .description('Sign in with GitHub to activate Switchman Pro')
    .option('--invite <token>', 'Join a team with an invite token')
    .option('--status', 'Show current login status')
    .addHelpText('after', `
Examples:
  switchman login
  switchman login --status
  switchman login --invite tk_8f3a2c
`)
    .action(async (opts) => {
      if (opts.status) {
        const creds = readCredentials();
        if (!creds?.access_token) {
          console.log('');
          console.log(`  ${chalk.dim('Status:')} Not logged in`);
          console.log(`  ${chalk.dim('Run:   ')} ${chalk.cyan('switchman login')}`);
          console.log('');
          return;
        }

        const licence = await checkLicence();
        console.log('');
        if (licence.valid) {
          console.log(`  ${chalk.green('✓')} Logged in as ${chalk.cyan(creds.email ?? 'unknown')}`);
          console.log(`  ${chalk.dim('Plan:')} ${licence.plan ?? 'Pro'}`);
          if (licence.current_period_end) {
            console.log(`  ${chalk.dim('Renews:')} ${new Date(licence.current_period_end).toLocaleDateString()}`);
          }
          if (licence.offline) {
            console.log(`  ${chalk.dim('(offline cache)')}`);
          }
          const pendingSync = getPendingQueueStatus();
          if ((pendingSync.pending || 0) > 0) {
            console.log(`  ${chalk.yellow('Pending team sync:')} ${pendingSync.pending} event(s) buffered locally`);
          }
        } else {
          console.log(`  ${chalk.yellow('⚠')} Logged in as ${chalk.cyan(creds.email ?? 'unknown')} but no active Pro licence`);
          console.log(`  ${chalk.dim('Upgrade at:')} ${chalk.cyan(PRO_PAGE_URL)}`);
        }
        console.log('');
        return;
      }

      if (opts.invite) {
        const creds = readCredentials();
        if (!creds?.access_token) {
          console.log('');
          console.log(chalk.yellow('  You need to sign in first before accepting an invite.'));
          console.log(`  ${chalk.dim('Run:')} ${chalk.cyan('switchman login')} ${chalk.dim('then try again with --invite')}`);
          console.log('');
          process.exit(1);
        }

        const sb = await createSupabaseAuthedClient(creds.access_token);
        const { data: { user } } = await sb.auth.getUser();
        if (!user) {
          console.log(chalk.red('  ✗  Could not verify your account. Run: switchman login'));
          process.exit(1);
        }

        const { data: invite, error: inviteError } = await sb
          .from('team_invites')
          .select('id, team_id, email, accepted')
          .eq('token', opts.invite)
          .maybeSingle();

        if (inviteError || !invite) {
          console.log('');
          console.log(chalk.red('  ✗  Invite token not found or already used.'));
          console.log(`  ${chalk.dim('Ask your teammate to send a new invite.')}`);
          console.log('');
          process.exit(1);
        }

        if (invite.accepted) {
          console.log('');
          console.log(chalk.yellow('  ⚠  This invite has already been accepted.'));
          console.log('');
          process.exit(1);
        }

        const { error: memberError } = await sb
          .from('team_members')
          .insert({ team_id: invite.team_id, user_id: user.id, role: 'member' });

        if (memberError && !memberError.message.includes('duplicate')) {
          console.log(chalk.red(`  ✗  Could not join team: ${memberError.message}`));
          process.exit(1);
        }

        await sb
          .from('team_invites')
          .update({ accepted: true })
          .eq('id', invite.id);

        console.log('');
        console.log(`  ${chalk.green('✓')}  Joined the team successfully`);
        console.log(`  ${chalk.dim('Your agents now share coordination with your teammates.')}`);
        console.log(`  ${chalk.dim('Run:')} ${chalk.cyan('switchman status')} ${chalk.dim('to see the shared view.')}`);
        console.log('');
        return;
      }

      const existing = readCredentials();
      if (existing?.access_token) {
        const licence = await checkLicence();
        if (licence.valid) {
          console.log('');
          console.log(`  ${chalk.green('✓')} Already logged in as ${chalk.cyan(existing.email ?? 'unknown')}`);
          console.log(`  ${chalk.dim('Plan:')} ${licence.plan ?? 'Pro'}`);
          console.log(`  ${chalk.dim('Run')} ${chalk.cyan('switchman login --status')} ${chalk.dim('to see full details')}`);
          console.log('');
          return;
        }
      }

      console.log('');
      console.log(chalk.bold('  Switchman Pro — sign in with GitHub'));
      console.log('');

      const spinner = ora('Waiting for GitHub sign-in...').start();
      spinner.stop();

      const result = await loginWithGitHub();

      if (!result.success) {
        console.log(`  ${chalk.red('✗')} Sign in failed: ${result.error ?? 'unknown error'}`);
        console.log(`  ${chalk.dim('Try again or visit:')} ${chalk.cyan(PRO_PAGE_URL)}`);
        console.log('');
        process.exit(1);
      }

      const licence = await checkLicence();

      console.log(`  ${chalk.green('✓')} Signed in as ${chalk.cyan(result.email ?? 'unknown')}`);

      if (licence.valid) {
        console.log(`  ${chalk.green('✓')} Pro licence verified — all features unlocked`);
        console.log(`  ${chalk.green('✓')} Switchman Pro active`);
        console.log(`  ${chalk.dim('Plan:')} ${licence.plan ?? 'Pro'}`);
        console.log('');
        console.log(`  ${chalk.dim('Credentials saved · valid 24h · 7-day offline grace')}`);
        console.log('');
        console.log(`  Run ${chalk.cyan('switchman setup --agents 10')} to start with unlimited agents.`);
      } else {
        console.log(`  ${chalk.yellow('⚠')} Signed in — no Pro licence found yet`);
        console.log('');
        console.log(`  ${chalk.dim('If you just subscribed, Polar may take 30–60 seconds to activate.')}`);
        console.log(`  ${chalk.dim('Check your status with:')} ${chalk.cyan('switchman login --status')}`);
        console.log('');
        console.log(`  ${chalk.dim('Not subscribed yet?')} ${chalk.cyan(PRO_PAGE_URL)}`);
      }

      console.log('');
    });

  program
    .command('logout')
    .description('Sign out and remove saved credentials')
    .action(() => {
      clearCredentials();
      console.log('');
      console.log(`  ${chalk.green('✓')} Signed out — credentials removed`);
      console.log('');
    });

  program
    .command('upgrade')
    .description('Open the Switchman Pro page in your browser')
    .action(async () => {
      console.log('');
      console.log(`  Opening ${chalk.cyan(PRO_PAGE_URL)}...`);
      console.log('');
      const { default: open } = await import('open');
      await open(PRO_PAGE_URL);
    });

  const teamCmd = program
    .command('team')
    .description('Manage your Switchman Pro team');

  teamCmd
    .command('invite <email>')
    .description('Invite a teammate to your shared coordination')
    .addHelpText('after', `
Examples:
  switchman team invite alice@example.com
`)
    .action(async (email) => {
      const licence = await checkLicence();
      if (!licence.valid) {
        console.log('');
        console.log(chalk.yellow('  ⚠  Team invites require Switchman Pro.'));
        console.log(`  ${chalk.dim('Run:')} ${chalk.cyan('switchman upgrade')}`);
        console.log('');
        process.exit(1);
      }

      getRepo();
      const creds = readCredentials();
      if (!creds?.access_token) {
        console.log('');
        console.log(chalk.yellow('  ⚠  You need to be logged in.'));
        console.log(`  ${chalk.dim('Run:')} ${chalk.cyan('switchman login')}`);
        console.log('');
        process.exit(1);
      }

      const sb = await createSupabaseAuthedClient(creds.access_token);
      const { data: { user } } = await sb.auth.getUser();
      if (!user) {
        console.log(chalk.red('  ✗  Could not verify your account. Run: switchman login'));
        process.exit(1);
      }

      let teamId;
      const { data: membership } = await sb
        .from('team_members')
        .select('team_id')
        .eq('user_id', user.id)
        .maybeSingle();

      if (membership?.team_id) {
        teamId = membership.team_id;
      } else {
        const { data: team, error: teamError } = await sb
          .from('teams')
          .insert({ owner_id: user.id, name: 'My Team' })
          .select('id')
          .single();

        if (teamError) {
          console.log(chalk.red(`  ✗  Could not create team: ${teamError.message}`));
          process.exit(1);
        }

        teamId = team.id;

        await sb.from('team_members').insert({
          team_id: teamId,
          user_id: user.id,
          role: 'owner',
        });
      }

      const { data: invite, error: inviteError } = await sb
        .from('team_invites')
        .insert({
          team_id: teamId,
          invited_by: user.id,
          email,
        })
        .select('token')
        .single();

      if (inviteError) {
        console.log(chalk.red(`  ✗  Could not create invite: ${inviteError.message}`));
        process.exit(1);
      }

      console.log('');
      console.log(`  ${chalk.green('✓')}  Invite created for ${chalk.cyan(email)}`);
      console.log('');
      console.log(`  They can join with:`);
      console.log(`  ${chalk.cyan(`switchman login --invite ${invite.token}`)}`);
      console.log('');
    });

  teamCmd
    .command('list')
    .description('List your team members')
    .action(async () => {
      const licence = await checkLicence();
      if (!licence.valid) {
        console.log('');
        console.log(chalk.yellow('  ⚠  Team features require Switchman Pro.'));
        console.log(`  ${chalk.dim('Run:')} ${chalk.cyan('switchman upgrade')}`);
        console.log('');
        process.exit(1);
      }

      const creds = readCredentials();
      if (!creds?.access_token) {
        console.log(chalk.red('  ✗  Not logged in. Run: switchman login'));
        process.exit(1);
      }

      const sb = await createSupabaseAuthedClient(creds.access_token);
      const { data: auth } = await sb.auth.getUser();
      const userId = auth.user?.id;
      const { data: membership } = await sb
        .from('team_members')
        .select('team_id')
        .eq('user_id', userId)
        .maybeSingle();

      if (!membership?.team_id) {
        console.log('');
        console.log(`  ${chalk.dim('No team yet. Invite someone with:')} ${chalk.cyan('switchman team invite <email>')}`);
        console.log('');
        return;
      }

      const { data: members } = await sb
        .from('team_members')
        .select('user_id, role, joined_at')
        .eq('team_id', membership.team_id);

      const { data: invites } = await sb
        .from('team_invites')
        .select('email, token, accepted, created_at')
        .eq('team_id', membership.team_id)
        .eq('accepted', false);

      console.log('');
      for (const m of members ?? []) {
        const roleLabel = m.role === 'owner' ? chalk.dim('(owner)') : chalk.dim('(member)');
        console.log(`  ${chalk.green('✓')} ${chalk.cyan(m.user_id.slice(0, 8))}  ${roleLabel}`);
      }
      for (const inv of invites ?? []) {
        console.log(`  ${chalk.dim('○')} ${chalk.cyan(inv.email)}  ${chalk.dim('(invited)')}`);
      }
      console.log('');
    });

  return teamCmd;
}
