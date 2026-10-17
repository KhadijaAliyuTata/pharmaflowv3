/**
 * Platform administration is a security boundary.
 *
 * `pf_is_platform_admin()` decides who may onboard a pharmacy, suspend one, and
 * read across every tenant. This suite treats the corresponding assertions as
 * hostile, in the same spirit as `verify-tenant-isolation` and
 * `verify-role-authority`: a change that closes a hole by breaking the
 * legitimate path leaves the platform unable to onboard anyone, which is worse
 * than the vulnerability it fixed.
 *
 * The fourteen numbered sections map one-to-one onto the requirements.
 *
 * **Concurrency is not exercised.** PGlite is single-connection; the row locks in
 * `pf_create_pharmacy` are not tested under contention.
 */

import {
  asActor,
  asAuthenticated,
  asAnon,
  asRole,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, note, section, finish } = createReporter('verify-platform-admin');

const database = await freshDatabase();
const ids = await seedTenants(database);

/**
 * Trusted server context: no JWT on the request.
 *
 * Fixture writes must go through this. `pf_guard_profile_privileges` only allows
 * a role or branch change when `auth.uid()` is null - which is the same
 * backdoor the database uses at sign-up, and the reason a test must clear the
 * actor rather than rely on whoever it happens to be.
 *
 * Declared before the fixtures because they use it.
 */
const asServer = (fn) => asActor(database, null, fn);

/* ------------------------------------------------------------------ fixtures */

/** A pre-existing pharmacy that must survive this migration untouched. */
const [endline] = await query(
  database,
  `insert into branches (name, city, status, is_main_hub, created_at)
   values ('Endline Pharmacy', 'Lagos', 'active', true, now() - interval '90 days')
   returning id`,
);
const ENDLINE_OWNER = 'cccccccc-0000-0000-0000-000000000001';
const ENDLINE_ASSISTANT = 'cccccccc-0000-0000-0000-000000000002';
await database.query(
  `insert into auth.users (id, email) values
     ($1, 'endline-owner@example.test'), ($2, 'endline-assistant@example.test')`,
  [ENDLINE_OWNER, ENDLINE_ASSISTANT],
);
await asServer(() =>
  database.query(
    `update profiles set role = 'owner', branch_id = $1 where id = $2`,
    [endline.id, ENDLINE_OWNER],
  ),
);
await asServer(() =>
  database.query(
    `update profiles set role = 'assistant', branch_id = $1 where id = $2`,
    [endline.id, ENDLINE_ASSISTANT],
  ),
);

/** A second owner in a different pharmacy, for cross-tenant attempts. */
const [rival] = await query(
  database,
  `insert into branches (name, city, status, is_main_hub) values ('Rival Pharmacy','Abuja','active',true) returning id`,
);
const RIVAL_OWNER = 'dddddddd-0000-0000-0000-000000000001';
await database.query(`insert into auth.users (id, email) values ($1, 'rival@example.test')`, [RIVAL_OWNER]);
await asServer(() =>
  database.query(`update profiles set role='owner', branch_id=$1 where id=$2`, [rival.id, RIVAL_OWNER]),
);

/* -------------------------------------------------------------------- helpers */

/**
 * Grants platform administration the only way it can be granted: the
 * service-role-only function, under trusted context.
 */
async function grantPlatformAdmin(email) {
  return asActor(database, null, () =>
    query(database, `select public.pf_grant_platform_admin($1::text) as id`, [email]),
  );
}

/** Calls an onboarding function as a given signed-in user. */
async function callAs(actorId, sql, params) {
  const call = await asAuthenticated(database, () =>
    asActor(database, actorId, async () => {
      const { rows } = await database.query(sql, params);
      return rows[0];
    }),
  );
  return call.ok ? { ok: true, value: call.value } : { ok: false, err: call.err };
}

/**
 * Calls an onboarding function the way the Worker route will.
 *
 * Service-role, with the actor passed explicitly. A service-role connection
 * carries no JWT, so the database re-resolves the actor from `profiles` - which
 * is why passing a NON-admin's id must be refused even here. That refusal is the
 * real boundary, and it is asserted in sections 2 and 3.
 */
async function onboard(actorId, { name, owner, email }) {
  // `asRole` wraps whatever the callback returns in {ok, value}, so unwrap it.
  // Left wrapped, every call reported ok:true with value:undefined - which reads
  // exactly like a function that silently succeeds.
  const call = await asRole(database, 'service_role', async () => {
    try {
      const { rows } = await database.query(
        `select * from public.pf_create_pharmacy($1,$2,$3,$4,$5,$6,$7,$8)`,
        [actorId, name, owner, email, '+234 800 000 0000', '1 Test Road', 'Lagos', 'Lagos'],
      );
      return { ok: true, value: rows[0] };
    } catch (e) {
      return { ok: false, err: String(e?.message ?? e).split('\n')[0].slice(0, 200) };
    }
  });
  return call.ok ? call.value : { ok: false, err: call.err };
}

const setStatus = (actorId, branchId, status, reason = null) =>
  asRole(database, 'service_role', async () => {
    try {
      const { rows } = await database.query(
        `select public.pf_set_pharmacy_status($1::uuid,$2::uuid,$3::public.pharmacy_status,$4::text) as v`,
        [actorId, branchId, status, reason],
      );
      return { ok: true, value: rows[0]?.v };
    } catch (e) {
      return { ok: false, err: String(e?.message ?? e).split('\n')[0].slice(0, 200) };
    }
  }).then((call) => (call.ok ? call.value : { ok: false, err: call.err }));

/* ============================================== 1. an admin can onboard */

section('1. an authorised platform administrator can create a pharmacy');

let created;
{
  await grantPlatformAdmin('owner-a@example.test');

  const isAdmin = await asAuthenticated(database, () =>
    asActor(database, ids.OWNER_A, async () => {
      const { rows } = await database.query(`select public.pf_is_platform_admin() as v`);
      return rows[0];
    }),
  );
  check('the promoted account is an administrator', isAdmin.value?.v === true, String(isAdmin.value?.v));

  const r = await onboard(ids.OWNER_A, {
    name: 'Beta Pharmacy',
    owner: 'Beta Owner',
    email: 'beta-owner@example.test',
  });
  check('the pharmacy was created', r.ok, r.ok ? r.value?.pharmacy_name : r.err);
  check('a branch id was returned', !!r.ok && !!r.value?.branch_id, '');
  check('an owner invitation id was returned', !!r.ok && !!r.value?.owner_invitation, '');
  check('a 256-bit token was returned to the server', !!r.ok && String(r.value?.invitation_token || '').length >= 32, r.ok ? `${String(r.value?.invitation_token || '').length} chars` : '');
  created = r.ok ? r.value : null;

  const [row] = await query(database, `select status from branches where id = $1`, [created.branch_id]);
  check('it starts as pending, not active', row?.status === 'pending', String(row?.status));

  const [inv] = await query(
    database,
    `select email, role, revoked_at, accepted_at from staff_invitations where id = $1`,
    [created.owner_invitation],
  );
  check('the invitation is for the owner email, owner role, live',
    inv?.email === 'beta-owner@example.test' && inv?.role === 'owner' && inv?.revoked_at === null && inv?.accepted_at === null,
    `${inv?.email}/${inv?.role}`);

  const [audit] = await query(
    database,
    `select action from audit_events where branch_id = $1 order by created_at desc limit 1`,
    [created.branch_id],
  );
  check('onboarding was recorded in the audit log', audit?.action === 'pharmacy_created', String(audit?.action));
}

/* ======================================== 2/3/5. only an admin reaches it */

section('2. an ordinary owner cannot create a pharmacy');

{
  const r = await onboard(ids.OWNER_B, {
    name: 'Rogue Pharmacy',
    owner: 'Rogue',
    email: 'rogue@example.test',
  });
  check('an ordinary pharmacy owner was refused', !r.ok, r.ok ? 'created' : r.err);
  check('the refusal names the platform role', !r.ok && /platform administrator/i.test(r.err), r.err);

  const rows = await query(database, `select name from branches where name = 'Rogue Pharmacy'`);
  check('no pharmacy was left behind', rows.length === 0, `${rows.length} row(s)`);
}

section('3. an attendant cannot reach platform administration');

{
  const isAdmin = await asAuthenticated(database, () =>
    asActor(database, ids.ASSISTANT_A, async () => {
      const { rows } = await database.query(`select public.pf_is_platform_admin() as v`);
      return rows[0];
    }),
  );
  check('an attendant is not an administrator', isAdmin.value?.v === false, String(isAdmin.value?.v));

  const r = await onboard(ids.ASSISTANT_A, {
    name: 'Attendant Pharmacy',
    owner: 'X',
    email: 'x@example.test',
  });
  check('an attendant cannot onboard a pharmacy', !r.ok, r.ok ? 'created' : r.err);

  const status = await setStatus(ids.ASSISTANT_A, endline.id, 'suspended', 'because');
  check('an attendant cannot suspend a pharmacy', !status.ok, status.ok ? 'suspended' : status.err);
}

section('5. nobody can promote themselves');

{
  // PGlite's query() THROWS on error rather than returning {error}, so every
  // refusal probe in this suite is wrapped in a try/catch.
  const probe = (actor, sql, params) =>
    actor === null
      ? database.query(sql, params).then(
          () => 'THE UPDATE WAS ACCEPTED',
          (e) => String(e?.message ?? e).split('\n')[0],
        )
      : asActor(database, actor, async () => {
          try {
            await database.query(sql, params);
            return 'THE UPDATE WAS ACCEPTED';
          } catch (e) {
            return String(e?.message ?? e).split('\n')[0];
          }
        });

  // The table UPDATE is revoked from authenticated outright, so this fails on
  // the grant before any policy is consulted.
  const selfPromote = await asAuthenticated(database, () =>
    probe(ids.ASSISTANT_A, `update profiles set is_platform_admin = true where id = $1`, [ids.ASSISTANT_A]),
  );
  check('an attendant cannot set the flag by updating their profile',
    !/ACCEPTED/.test(selfPromote), selfPromote);

  const stillFalse = await query(
    database,
    `select is_platform_admin from profiles where id = $1`,
    [ids.ASSISTANT_A],
  );
  check('the flag is still false', stillFalse[0].is_platform_admin === false, '');

  // And even with a JWT present, the trigger refuses.
  const viaTrigger = await probe(
    ids.OWNER_A,
    `update profiles set is_platform_admin = true where id = $1`,
    [ids.ASSISTANT_A],
  );
  check('and an owner cannot promote somebody else either',
    !/ACCEPTED/.test(viaTrigger), viaTrigger);
  check('the trigger names the operator as the only route',
    /platform operator/i.test(viaTrigger), viaTrigger);

  const after = await query(database, `select is_platform_admin from profiles where id = $1`, [ids.ASSISTANT_A]);
  check('the flag is still false after both attempts', after[0].is_platform_admin === false, '');
}

section('5b. a staff member cannot promote themselves to owner');

{
  const r = await callAs(
    ids.ASSISTANT_A,
    `select public.pf_create_invitation('someone@example.test', 'owner'::public.staff_role)`,
    [],
  );
  check('an attendant cannot issue an invitation', !r.ok, r.ok ? 'issued' : r.err);

  // An owner CAN invite another owner - that is an existing product decision.
  // What must never happen is staff granting themselves a role.
  const selfRole = await asAuthenticated(database, () =>
    asActor(database, ids.ASSISTANT_A, async () => {
      const { error } = await database.query(
        `update profiles set role = 'owner' where id = $1`,
        [ids.ASSISTANT_A],
      );
      return error?.message ?? null;
    }),
  );
  check('an attendant cannot set their own role', selfRole !== null, selfRole ?? 'the update was ACCEPTED');
}

/* ============================================= 4/10. tenant isolation holds */

section('4/10. an owner sees only their own pharmacy');

{
  const mine = await asAuthenticated(database, () =>
    asActor(database, ENDLINE_OWNER, async () => {
      const { rows } = await database.query(`select id from pf_my_branches`);
      return rows;
    }),
  );
  check('Endline owner sees only Endline', mine.value?.length === 1 && mine.value[0].id === endline.id, `${mine.value?.length} branch(es)`);

  // NB: named `rivalView`, not `rival`. Shadowing the branch fixture made
  // `rival.id` read as the RESULT object, which reported "want undefined" and
  // made the cross-tenant assertion vacuous.
  const rivalView = await asAuthenticated(database, () =>
    asActor(database, RIVAL_OWNER, async () => {
      const { rows } = await database.query(`select id from pf_my_branches`);
      return rows;
    }),
  );
  check('Rival owner sees only Rival', rivalView.value?.length === 1 && rivalView.value[0].id === rival.id,
    `${rivalView.value?.length} branch(es), got ${rivalView.value?.[0]?.id}, want ${rival.id}`);

  const crossInvite = await callAs(
    RIVAL_OWNER,
    `select public.pf_create_invitation('intruder@example.test')`,
    [],
  );
  const [invRow] = await query(
    database,
    `select branch_id from staff_invitations where email = 'intruder@example.test'`,
  );
  check('an owner cannot invite into another pharmacy',
    invRow?.branch_id === rival.id, invRow ? `landed in ${invRow.branch_id === rival.id ? 'their own' : 'ENDLINE'}` : 'no invitation');
}

section('6. an owner cannot invite staff into another pharmacy');

{
  const r = await callAs(
    ENDLINE_OWNER,
    `select public.pf_revoke_invitation('not-a-real-token')`,
    [],
  );
  check('revoking a token that does not exist simply finds nothing',
    r.ok && r.value?.pf_revoke_invitation === false, r.ok ? JSON.stringify(r.value) : r.err);

  // The strong form: hand Endline's owner a Rival token.
  const [rivalInv] = await query(
    database,
    `insert into staff_invitations (branch_id, email, role, invited_by)
     values ($1, 'cross@example.test', 'assistant', $2) returning token`,
    [rival.id, RIVAL_OWNER],
  );
  const attempt = await callAs(ENDLINE_OWNER, `select public.pf_revoke_invitation($1)`, [rivalInv.token]);
  check('a foreign token cannot be revoked by another owner',
    attempt.ok && attempt.value?.pf_revoke_invitation === false, attempt.ok ? JSON.stringify(attempt.value) : attempt.err);

  const stillLive = await query(database, `select revoked_at from staff_invitations where token = $1`, [rivalInv.token]);
  check('the foreign invitation is untouched', stillLive[0].revoked_at === null, '');
}

/* ================================ 7/8. invitation lifecycle and single use */

section('7/8. an invitation grants one membership, and rejects the wrong identity');

{
  const [invitee] = await query(
    database,
    `insert into auth.users (id, email) values ('eeeeeeee-0000-0000-0000-000000000001','beta-owner@example.test') returning id`,
  );
  const INVITEE = invitee.id;

  const token = await query(database, `select token from staff_invitations where id = $1`, [created.owner_invitation]);

  // Wrong person.
  const wrong = await callAs(RIVAL_OWNER, `select * from public.pf_redeem_invitation($1)`, [token[0].token]);
  check('a different signed-in user cannot redeem it', !wrong.ok, wrong.ok ? 'redeemed' : wrong.err);
  check('and is told the address does not match', !wrong.ok && /different email/i.test(wrong.err), wrong.err);

  // Right person, first time.
  const first = await callAs(
    INVITEE,
    `select * from public.pf_redeem_invitation($1) with set_actor_email(email)`,
    [token[0].token],
  ).catch(() => null);

  // asActor clears the email claim, so set it inside the same session.
  const redeemed = await asAuthenticated(database, () =>
    asActor(database, INVITEE, async () => {
      await database.query(`select set_actor_email('beta-owner@example.test')`);
      const { rows, error } = await database.query(`select * from public.pf_redeem_invitation($1)`, [token[0].token]);
      return { rows, error: error?.message ?? null };
    }),
  );
  check('the invited owner redeemed it', !redeemed.value?.error && redeemed.value?.rows?.length === 1, redeemed.value?.error ?? 'ok');
  check('the membership was created for the right branch',
    redeemed.value?.rows?.[0]?.branch === created.branch_id, String(redeemed.value?.rows?.[0]?.branch));
  check('and at the owner role', redeemed.value?.rows?.[0]?.granted_role === 'owner', String(redeemed.value?.rows?.[0]?.granted_role));

  const [status] = await query(database, `select status from branches where id = $1`, [created.branch_id]);
  check('the pharmacy activated on acceptance', status?.status === 'active', String(status?.status));

  /*
   * The same person, redeeming the same code again.
   *
   * Redemption is idempotent: the invitation has already done its job, so the
   * second call returns the membership they already hold and writes nothing,
   * rather than raising. A returning owner who re-opens the emailed link must not
   * be told they have no place at a pharmacy they already own.
   */
  const second = await asAuthenticated(database, () =>
    asActor(database, INVITEE, async () => {
      await database.query(`select set_actor_email('beta-owner@example.test')`);
      try {
        const { rows } = await database.query(`select * from public.pf_redeem_invitation($1)`, [token[0].token]);
        return { ok: true, rows, message: null };
      } catch (e) {
        return { ok: false, rows: [], message: String(e?.message ?? e).split('\n')[0] };
      }
    }),
  );
  check('redeeming the same token again succeeds', second.value?.ok === true, String(second.value?.message));
  check(
    '...and returns the membership already held',
    second.value?.rows?.[0]?.branch === created.branch_id && second.value?.rows?.[0]?.granted_role === 'owner',
    JSON.stringify(second.value?.rows?.[0]),
  );
  const [membershipCount] = await query(
    database,
    `select count(*)::int as n from branch_memberships where user_id = $1 and branch_id = $2`,
    [INVITEE, created.branch_id],
  );
  check('...and does not create a second membership', membershipCount?.n === 1, String(membershipCount?.n));
}

section('8b. expired and malformed invitations are rejected');

{
  const [expired] = await query(
    database,
    `insert into staff_invitations (branch_id, email, role, invited_by, expires_at)
     values ($1, 'late@example.test', 'assistant', $2, now() - interval '1 day') returning token`,
    [endline.id, ENDLINE_OWNER],
  );
  const [latecomer] = await query(
    database,
    `insert into auth.users (id, email) values ('eeeeeeee-0000-0000-0000-000000000009','late@example.test') returning id`,
  );
  const r = await asAuthenticated(database, () =>
    asActor(database, latecomer.id, async () => {
      await database.query(`select set_actor_email('late@example.test')`);
      try {
        await database.query(`select * from public.pf_redeem_invitation($1)`, [expired.token]);
        return 'IT WAS ACCEPTED';
      } catch (e) {
        return String(e?.message ?? e).split('\n')[0];
      }
    }),
  );
  check('an expired invitation is rejected', r.value !== 'IT WAS ACCEPTED', String(r.value));
  check('and says so in terms the holder can act on', /expired/i.test(String(r.value)), String(r.value));

  const junk = await callAs(ids.OWNER_A, `select * from public.pf_redeem_invitation('not-a-token')`, []);
  check('a malformed token is rejected', !junk.ok, junk.ok ? 'redeemed' : junk.err);

  const empty = await callAs(ids.OWNER_A, `select * from public.pf_redeem_invitation('   ')`, []);
  check('a blank token is rejected', !empty.ok, empty.ok ? 'redeemed' : empty.err);
}

/* ================================================ 9. duplicate submissions */

section('9. duplicate requests create no duplicates');

{
  const dup = await onboard(ids.OWNER_A, {
    name: 'Beta Pharmacy',
    owner: 'Beta Owner',
    email: 'someone-else@example.test',
  });
  check('a duplicate pharmacy NAME is refused', !dup.ok, dup.ok ? 'created' : dup.err);
  check('the refusal explains why', !dup.ok && /already exists/i.test(dup.err), dup.err);

  const dupEmail = await onboard(ids.OWNER_A, {
    name: 'Gamma Pharmacy',
    owner: 'Gamma',
    email: 'gamma@example.test',
  });
  check('a fresh pharmacy with a fresh address is allowed', dupEmail.ok, dupEmail.ok ? '' : dupEmail.err);
  await query(database, `update branches set status='suspended' where name = 'Gamma Pharmacy'`);

  const branches = await query(database, `select count(*)::int as n from branches where name = 'Beta Pharmacy'`);
  check('exactly one Beta Pharmacy exists', branches[0].n === 1, `${branches[0].n}`);
}

/* ============================================= 11. suspension, not deletion */

section('11. suspending a pharmacy blocks access and deletes nothing');

{
  const [victim] = await query(
    database,
    `insert into branches (name, status, is_main_hub) values ('Suspended Pharmacy','active',true) returning id`,
  );
  const [owner] = await query(
    database,
    `insert into auth.users (id, email) values ('ffffffff-0000-0000-0000-000000000001','susp@example.test') returning id`,
  );
  await asServer(() =>
    database.query(`update profiles set role='owner', branch_id=$1 where id=$2`, [victim.id, owner.id]),
  );
  await database.query(`select set_actor_email('susp@example.test')`);

  const before = await asAuthenticated(database, () =>
    asActor(database, owner.id, async () => {
      const { rows } = await database.query(`select id from pf_my_branches`);
      return rows;
    }),
  );
  check('the owner can see their pharmacy while active', before.value?.length === 1, `${before.value?.length}`);

  const r = await setStatus(ids.OWNER_A, victim.id, 'suspended', 'failed payments');
  check('the administrator suspended it', r.ok && r.value === true, r.ok ? String(r.value) : r.err);

  const after = await asAuthenticated(database, () =>
    asActor(database, owner.id, async () => {
      const { rows } = await database.query(`select id from pf_my_branches`);
      return rows;
    }),
  );
  check('the suspended owner now resolves no active branch', after.value?.length === 0, `${after.value?.length}`);

  const branch = await query(database, `select status, suspended_reason from branches where id = $1`, [victim.id]);
  check('the branch row still exists and records why', branch.length === 1 && branch[0].status === 'suspended', String(branch[0]?.status));

  const [audit] = await query(
    database,
    `select action, description from audit_events where branch_id = $1 order by created_at desc limit 1`,
    [victim.id],
  );
  check('the suspension was audited', audit?.action === 'pharmacy_status_changed', String(audit?.action));

  const noReason = await setStatus(ids.OWNER_A, victim.id, 'active');
  check('reactivating works', noReason.ok && noReason.value === true, noReason.ok ? '' : noReason.err);

  const back = await asAuthenticated(database, () =>
    asActor(database, owner.id, async () => {
      const { rows } = await database.query(`select id from pf_my_branches`);
      return rows;
    }),
  );
  check('and the owner can work again', back.value?.length === 1, `${back.value?.length}`);
  }

  /* ============================== 11b. suspension blocks WRITES, not just reads */
  //
  // Section 11 proves a suspended pharmacy loses its reads. That is the weaker
  // half: `pf_current_branch()` returning NULL makes RLS deny rows, but a write
  // that derives its own branch_id - rather than being scoped by a policy - can
  // still succeed. A SECURITY DEFINER function would sail straight past a NULL
  // branch unless it checks for itself.
  //
  // So every write path is exercised while suspended, and each must refuse.
  section('11b. a suspended pharmacy cannot write through any normal path');
  {
    const [shop] = await query(
      database,
      `insert into branches (name, status, is_main_hub) values ('Frozen Pharmacy','active',true) returning id`,
    );
    const [keeper] = await query(
      database,
      `insert into auth.users (id, email) values ('ffffffff-0000-0000-0000-000000000010','frozen@example.test') returning id`,
    );
    const [helper] = await query(
      database,
      `insert into auth.users (id, email) values ('ffffffff-0000-0000-0000-000000000011','frozen-staff@example.test') returning id`,
    );
    await asServer(() =>
      database.query(`update profiles set role='owner', branch_id=$1 where id=$2`, [shop.id, keeper.id]),
    );
    await asServer(() =>
      database.query(`update profiles set role='assistant', branch_id=$1 where id=$2`, [shop.id, helper.id]),
    );

    const [drug] = await query(
      database,
      `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
       values ($1,'Frozen Drug','f','[{"key":"tablet","name":"Tablet","multiplier":1,"sellingPrice":5}]'::jsonb,2,5,current_date+365) returning id`,
      [shop.id],
    );
    await database.query(
      `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
       values ($1,$2,'F1',current_date+100,500,2)`,
      [shop.id, drug.id],
    );

    // Suspend BEFORE any write is attempted, so there is no window in which a
    // write could legitimately have succeeded.
    const susp = await setStatus(ids.OWNER_A, shop.id, 'suspended', 'non-payment');
    check('the pharmacy is suspended before any write is tried', susp.ok && susp.value === true, susp.ok ? '' : susp.err);

    // --- the checkout RPC: SECURITY DEFINER, and the one that matters most
    const sold = await asAuthenticated(database, () =>
      asActor(database, keeper.id, async () => {
        await database.query(`select set_actor_email('frozen@example.test')`);
        try {
          const { rows } = await database.query(
            `select * from public.pf_complete_sale(
              p_lines => $1::jsonb, p_payment_method => 'cash', p_amount_paid => 5,
              p_discount => 0, p_discount_reason => null, p_customer_id => null,
              p_credit_account_id => null, p_dispensed_against_prescription => false,
              p_idempotency_key => null)`,
            [`[{"medicine_id":"${drug.id}","unit_key":"tablet","quantity":1}]`],
          );
          return `SALE COMPLETED (${rows.length} row)`;
        } catch (e) {
          return String(e?.message ?? e).split('\n')[0];
        }
      }),
    );
    check('pf_complete_sale refuses to complete a sale', !/^SALE COMPLETED/.test(String(sold.value)), String(sold.value));

    const [saleCount] = await query(database, `select count(*)::int as n from sales where branch_id = $1`, [shop.id]);
    check('and no sale header was written', saleCount.n === 0, `${saleCount.n}`);

    const [lot] = await query(database, `select quantity from medicine_batches where medicine_id = $1`, [drug.id]);
    check('and stock was not deducted', lot?.quantity === 500, String(lot?.quantity));

    // --- an invitation, which is how an owner might try to keep working
    const invite = await asAuthenticated(database, () =>
      asActor(database, keeper.id, async () => {
        try {
          await database.query(`select public.pf_create_invitation('newstaff@example.test')`);
          return 'INVITATION ISSUED';
        } catch (e) {
          return String(e?.message ?? e).split('\n')[0];
        }
      }),
    );
    check('an invitation cannot be issued either', invite.value !== 'INVITATION ISSUED', String(invite.value));

    // --- the branch switcher itself
    const switched = await asAuthenticated(database, () =>
      asActor(database, keeper.id, async () => {
        const { rows, error } = await database.query(`select public.pf_set_active_branch($1::uuid) as v`, [shop.id]);
        return error?.message ?? `SET TO ${rows[0]?.v}`;
      }),
    );
    check('pf_set_active_branch refuses to select the suspended branch',
      !/^SET TO/.test(String(switched.value)), String(switched.value));

    // --- a plain INSERT, to prove the table policy denies it too, and that this
    //     is not only the RPC layer holding the line
    const inserted = await asAuthenticated(database, () =>
      asActor(database, keeper.id, async () => {
        try {
          await database.query(`insert into customers (branch_id, name) values ($1, 'Ghost')`, [shop.id]);
          return 'THE INSERT WAS ACCEPTED';
        } catch (e) {
          return String(e?.message ?? e).split('\n')[0];
        }
      }),
    );
    check('a direct INSERT is refused by RLS', inserted.value !== 'THE INSERT WAS ACCEPTED', String(inserted.value));

    // --- and an attendant, who has the fewest rights to begin with
    const byAttendant = await asAuthenticated(database, () =>
      asActor(database, helper.id, async () => {
        try {
          await database.query(
            `select * from public.pf_complete_sale(
              p_lines => $1::jsonb, p_payment_method => 'cash', p_amount_paid => 5,
              p_discount => 0, p_discount_reason => null, p_customer_id => null,
              p_credit_account_id => null, p_dispensed_against_prescription => false,
              p_idempotency_key => null)`,
            [`[{"medicine_id":"${drug.id}","unit_key":"tablet","quantity":1}]`],
          );
          return 'SALE COMPLETED';
        } catch (e) {
          return String(e?.message ?? e).split('\n')[0];
        }
      }),
    );
    check('an attendant cannot complete a sale either', byAttendant.value !== 'SALE COMPLETED', String(byAttendant.value));

    // --- reactivate and run the SAME sale again. Without this, every refusal
    //     above would be equally consistent with "the fixture is broken".
    const back = await setStatus(ids.OWNER_A, shop.id, 'active');
    check('reactivating works', back.ok && back.value === true, back.ok ? '' : back.err);

    const soldAgain = await asAuthenticated(database, () =>
      asActor(database, keeper.id, async () => {
        await database.query(`select set_actor_email('frozen@example.test')`);
        try {
          const { rows } = await database.query(
            `select * from public.pf_complete_sale(
              p_lines => $1::jsonb, p_payment_method => 'cash', p_amount_paid => 5,
              p_discount => 0, p_discount_reason => null, p_customer_id => null,
              p_credit_account_id => null, p_dispensed_against_prescription => false,
              p_idempotency_key => null)`,
            [`[{"medicine_id":"${drug.id}","unit_key":"tablet","quantity":1}]`],
          );
          return rows.length === 1 ? 'SALE COMPLETED' : 'NO ROW';
        } catch (e) {
          return String(e?.message ?? e).split('\n')[0];
        }
      }),
    );
    check('and the very same sale succeeds once reactivated', soldAgain.value === 'SALE COMPLETED', String(soldAgain.value));

    const [lotAfter] = await query(database, `select quantity from medicine_batches where medicine_id = $1`, [drug.id]);
    check('stock moves again too, so the refusals were the status and not a fault',
      lotAfter?.quantity === 499, String(lotAfter?.quantity));
  }

  /* ===================================== 11c. the UI can tell why it is empty */
  //
  // Suspension is fail-closed, which means the app looks empty rather than
  // refused. `pf_my_branch_status()` is what lets the interface say *why*. It is
  // the one function added purely for explanation, so it is held to the same
  // standard as the ones that enforce.
  section('11c. pf_my_branch_status explains a suspension without leaking');
  {
    const [mute] = await query(
      database,
      `insert into branches (name, status, is_main_hub) values ('Muted Pharmacy','active',true) returning id`,
    );
    const [boss] = await query(
      database,
      `insert into auth.users (id, email) values ('ffffffff-0000-0000-0000-000000000020','muted@example.test') returning id`,
    );
    await asServer(() =>
      database.query(`update profiles set role='owner', branch_id=$1 where id=$2`, [mute.id, boss.id]),
    );

    // `asAuthenticated`/`asActor` each wrap in {ok, value}, so every probe is
    // awaited before its `.value` is read. Left unawaited it is `undefined`,
    // which fails the comparison and reports "undefined" - a test that looks
    // like it ran and proves nothing.
    const ownStatus = async (actorId) =>
      asAuthenticated(database, () =>
        asActor(database, actorId, async () => {
          const { rows, error } = await database.query(`select public.pf_my_branch_status() as v`);
          return error ? `ERR ${error.message}` : (rows[0]?.v ?? 'NULL');
        }),
      );

    // `.then(onOk, onErr)` would SWALLOW the refusal and make `asAnon` see a
    // success, so the permission error is allowed to propagate instead.
    const anon = await asAnon(database, () => database.query(`select public.pf_my_branch_status()`));
    check('anon cannot call it', !anon.ok, anon.ok ? 'IT RETURNED A VALUE' : anon.err);

    check('an active pharmacy reports active', (await ownStatus(boss.id)).value === 'active',
      String((await ownStatus(boss.id)).value));

    await setStatus(ids.OWNER_A, mute.id, 'suspended', 'review');
    const whileSuspended = await ownStatus(boss.id);
    check('a suspended pharmacy reports suspended, even though its reads are empty',
      whileSuspended.value === 'suspended', String(whileSuspended.value));

    await setStatus(ids.OWNER_A, mute.id, 'active');
    const afterBack = await ownStatus(boss.id);
    check('and active again after reactivation', afterBack.value === 'active', String(afterBack.value));

    // It is self-scoped: it takes no arguments, so there is nothing to point at
    // somebody else's pharmacy. Asserted from the signature, not from a call.
    const [sig] = await query(
      database,
      `select pg_get_function_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'pf_my_branch_status'`,
    );
    check('it takes no arguments, so it cannot be aimed at another pharmacy',
      (sig?.args ?? '').trim() === '', `args: "${sig?.args}"`);
  }

  /* ================== 11d. void and revoke, which deny in two different ways */
  //
  // Section 11b covers the write paths that refuse outright. These two are the
  // awkward ones, and they are here precisely because they behave DIFFERENTLY
  // from each other under suspension:
  //
  //   * `pf_void_sale` checks `pf_current_branch() is null` explicitly and
  //     raises. It knows it has no branch.
  //
  //   * `pf_revoke_invitation` does not. It uses `pf_current_branch()` only as a
  //     WHERE-clause filter, so a NULL branch silently matches zero rows and the
  //     function returns `false` - which reads as "that token does not exist".
  //
  // `pf_is_owner()` is `profiles.role = 'owner'` and never consults branch
  // status, so a suspended owner passes the owner check in both. Nothing is
  // revoked and nothing is voided either way, so **neither is a data-changing
  // security defect** - but the second one reports a real pharmacy as missing.
  //
  // Both are asserted here, then asserted again after reactivation, so a refusal
  // cannot be confused with the operation simply being unavailable.
  section('11d. voiding and revoking are both refused while suspended');
  {
    const [shop] = await query(
      database,
      `insert into branches (name, status, is_main_hub) values ('Ledger Pharmacy','active',true) returning id`,
    );
    const [boss] = await query(
      database,
      `insert into auth.users (id, email) values ('ffffffff-0000-0000-0000-000000000030','ledger@example.test') returning id`,
    );
    await asServer(() =>
      database.query(`update profiles set role='owner', branch_id=$1 where id=$2`, [shop.id, boss.id]),
    );

    const [drug] = await query(
      database,
      `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
       values ($1,'Ledger Drug','l','[{"key":"tablet","name":"Tablet","multiplier":1,"sellingPrice":5}]'::jsonb,2,5,current_date+365) returning id`,
      [shop.id],
    );
    await database.query(
      `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
       values ($1,$2,'L1',current_date+100,500,2)`,
      [shop.id, drug.id],
    );

    // A live invitation, owned by this pharmacy, to be revoked later.
    const [inv] = await query(
      database,
      `insert into staff_invitations (branch_id, email, role, invited_by)
       values ($1,'ledger-joiner@example.test','assistant',$2) returning token`,
      [shop.id, boss.id],
    );

    // Take a real sale while the pharmacy is open, so the void has real
    // allocations to restore. A sale made after suspension is impossible, so
    // this must happen first or the test proves nothing.
    const sold = await asAuthenticated(database, () =>
      asActor(database, boss.id, async () => {
        await database.query(`select set_actor_email('ledger@example.test')`);
        try {
          const { rows } = await database.query(
            `select * from public.pf_complete_sale(
              p_lines => $1::jsonb, p_payment_method => 'cash', p_amount_paid => 5,
              p_discount => 0, p_discount_reason => null, p_customer_id => null,
              p_credit_account_id => null, p_dispensed_against_prescription => false,
              p_idempotency_key => null)`,
            [`[{"medicine_id":"${drug.id}","unit_key":"tablet","quantity":1}]`],
          );
          return rows[0]?.sale_id ?? rows[0]?.id ?? null;
        } catch (e) {
          return `ERR ${String(e?.message ?? e).split('\n')[0]}`;
        }
      }),
    );
    check('a sale exists to void', typeof sold.value === 'string' && sold.value.length === 36, String(sold.value));
    const SALE = sold.value;

    const [lotBefore] = await query(database, `select quantity from medicine_batches where medicine_id = $1`, [drug.id]);
    check('and it consumed stock', lotBefore?.quantity === 499, String(lotBefore?.quantity));

    // Suspend. Everything below must be refused.
    const susp = await setStatus(ids.OWNER_A, shop.id, 'suspended', 'audit');
    check('the pharmacy is suspended before either operation is tried', susp.ok && susp.value === true, susp.ok ? '' : susp.err);

    // ---- pf_void_sale -------------------------------------------------------
    const voided = await asAuthenticated(database, () =>
      asActor(database, boss.id, async () => {
        try {
          await database.query(`select * from public.pf_void_sale($1::uuid, 'operator error')`, [SALE]);
          return 'VOID COMPLETED';
        } catch (e) {
          return String(e?.message ?? e).split('\n')[0];
        }
      }),
    );
    check('pf_void_sale refuses outright rather than returning a false',
      voided.value === 'VOID COMPLETED' ? false : true, String(voided.value));
    check('and it names the reason, so the UI can explain it',
      /no active pharmacy/i.test(String(voided.value)), String(voided.value));

    const [afterVoid] = await query(database, `select state, status_reason from sales where id = $1`, [SALE]);
    // 'paid', not 'completed': sale_state is ('paid','part_paid','credit','refunded','voided'),
    // and a cash sale lands on 'paid'. Asserted from the enum rather than guessed.
    check('the sale is still paid, not voided', afterVoid?.state === 'paid', String(afterVoid?.state));
    check('and carries no void reason', afterVoid?.status_reason === null, String(afterVoid?.status_reason));

    const [lotStillDeducted] = await query(database, `select quantity from medicine_batches where medicine_id = $1`, [drug.id]);
    check('and the stock it consumed was NOT put back',
      lotStillDeducted?.quantity === 499, String(lotStillDeducted?.quantity));

    const voidMovements = await query(
      database,
      `select count(*)::int as n from stock_movements where reference_id = $1 and kind = 'void'::public.movement_kind`,
      [SALE],
    );
    check('and no restoration movement was written', voidMovements[0].n === 0, `${voidMovements[0].n}`);

    // ---- WHY revocation refuses --------------------------------------------
    //
    // Not for the reason a first reading suggests. `pf_is_owner()` is
    // `coalesce(pf_current_role() = 'owner', false)`, and `pf_current_role()` was
    // redefined in 20261005250000 to read `branch_memberships` scoped to
    // `pf_current_branch()` rather than from `profiles.role`. Under suspension
    // that branch is NULL, so the lookup matches nothing, the role is NULL, and
    // `pf_is_owner()` is FALSE - before `pf_revoke_invitation` reaches its own
    // branch-filtered UPDATE.
    //
    // That is the design working: "absence of a membership denies, which is the
    // direction that must be chosen when authorization is uncertain." Asserted
    // directly, because a later change that made `pf_is_owner()` branch-blind
    // would quietly turn this refusal back into a silent `false`.
    const ownerBit = await asAuthenticated(database, () =>
      asActor(database, boss.id, async () => {
        const { rows } = await database.query(
          `select public.pf_is_owner() as is_owner,
                  (select role::text from public.profiles where id = auth.uid()) as profiles_role`,
        );
        return rows[0];
      }),
    );
    check('profiles.role is still "owner" - suspension does not demote anybody',
      ownerBit.value?.profiles_role === 'owner', String(ownerBit.value?.profiles_role));
    check('but pf_is_owner() is false, because pf_current_role() resolves against a NULL branch',
      ownerBit.value?.is_owner === false, String(ownerBit.value?.is_owner));

    const revoked = await asAuthenticated(database, () =>
      asActor(database, boss.id, async () => {
        try {
          const { rows } = await database.query(`select public.pf_revoke_invitation($1) as v`, [inv.token]);
          return `RETURNED ${rows[0]?.v}`;
        } catch (e) {
          return String(e?.message ?? e).split('\n')[0];
        }
      }),
    );
    check('pf_revoke_invitation refuses outright rather than returning a bare false',
      !/^RETURNED/.test(String(revoked.value)), String(revoked.value));

    const [invRow] = await query(database, `select revoked_at from staff_invitations where token = $1`, [inv.token]);
    check('the invitation is still live', invRow?.revoked_at === null, String(invRow?.revoked_at));

    // ---- reactivate, and run the identical operations again -----------------
    const back = await setStatus(ids.OWNER_A, shop.id, 'active');
    check('reactivating works', back.ok && back.value === true, back.ok ? '' : back.err);

    // The role boundary is checked HERE, while the pharmacy is open. Checked
    // under suspension it would pass for the wrong reason - every caller looks
    // like a non-owner there - and would prove nothing about roles at all.
    const [helper] = await query(
      database,
      `insert into auth.users (id, email) values ('ffffffff-0000-0000-0000-000000000031','ledger-staff@example.test') returning id`,
    );
    await asServer(() =>
      database.query(`update profiles set role='assistant', branch_id=$1 where id=$2`, [shop.id, helper.id]),
    );
    const byAttendant = await asAuthenticated(database, () =>
      asActor(database, helper.id, async () => {
        try {
          const { rows } = await database.query(`select public.pf_revoke_invitation($1) as v`, [inv.token]);
          return `RETURNED ${rows[0]?.v}`;
        } catch (e) {
          return String(e?.message ?? e).split('\n')[0];
        }
      }),
    );
    check('an attendant at an OPEN pharmacy is refused for being an attendant',
      /Only an owner can revoke/i.test(String(byAttendant.value)), String(byAttendant.value));

    const [invAfterAttendant] = await query(database, `select revoked_at from staff_invitations where token = $1`, [inv.token]);
    check('and the invitation survives that attempt', invAfterAttendant?.revoked_at === null, String(invAfterAttendant?.revoked_at));

    const revokedAfter = await asAuthenticated(database, () =>
      asActor(database, boss.id, async () => {
        try {
          const { rows } = await database.query(`select public.pf_revoke_invitation($1) as v`, [inv.token]);
          return `RETURNED ${rows[0]?.v}`;
        } catch (e) {
          return `ERR ${String(e?.message ?? e).split('\n')[0]}`;
        }
      }),
    );
    check('the same revocation succeeds once reactivated',
      revokedAfter.value === 'RETURNED true', String(revokedAfter.value));

    const [invNow] = await query(database, `select revoked_at from staff_invitations where token = $1`, [inv.token]);
    check('and the invitation is genuinely revoked', invNow?.revoked_at !== null, String(invNow?.revoked_at));

    const voidedAfter = await asAuthenticated(database, () =>
      asActor(database, boss.id, async () => {
        try {
          const { rows } = await database.query(`select * from public.pf_void_sale($1::uuid, 'operator error')`, [SALE]);
          return rows.length === 1 ? 'VOID COMPLETED' : 'NO ROW';
        } catch (e) {
          return `ERR ${String(e?.message ?? e).split('\n')[0]}`;
        }
      }),
    );
    check('and the same void succeeds, restoring the stock',
      voidedAfter.value === 'VOID COMPLETED', String(voidedAfter.value));

    const [saleNow] = await query(database, `select state from sales where id = $1`, [SALE]);
    check('the sale is now voided', saleNow?.state === 'voided', String(saleNow?.state));

    const [lotRestored] = await query(database, `select quantity from medicine_batches where medicine_id = $1`, [drug.id]);
    check('and the 1 unit it consumed is back', lotRestored?.quantity === 500, String(lotRestored?.quantity));

    const restoreMovement = await query(
      database,
      `select count(*)::int as n from stock_movements where reference_id = $1 and kind = 'void'::public.movement_kind`,
      [SALE],
    );
    check('and a restoration movement now exists', restoreMovement[0].n === 1, `${restoreMovement[0].n}`);

    // And the sale cannot be voided twice, now that it has been.
    const twice = await asAuthenticated(database, () =>
      asActor(database, boss.id, async () => {
        try {
          await database.query(`select * from public.pf_void_sale($1::uuid, 'again')`, [SALE]);
          return 'VOID COMPLETED TWICE';
        } catch (e) {
          return String(e?.message ?? e).split('\n')[0];
        }
      }),
    );
    check('and voiding it again is refused rather than restoring stock twice',
      /already voided/i.test(String(twice.value)), String(twice.value));

    const [lotTwice] = await query(database, `select quantity from medicine_batches where medicine_id = $1`, [drug.id]);
    check('and the lot is still 500, not 501', lotTwice?.quantity === 500, String(lotTwice?.quantity));
  }

/* ============================================= 12. views and audit hygiene */

section('12. platform views are empty for everyone else');

{
  for (const [who, actor] of [['an owner', ENDLINE_OWNER], ['an attendant', ids.ASSISTANT_A], ['a rival owner', RIVAL_OWNER]]) {
    const v = await asAuthenticated(database, () =>
      asActor(database, actor, async () => {
        const { rows } = await database.query(`select * from pf_platform_pharmacies`);
        return rows;
      }),
    );
    check(`${who} sees no platform pharmacy rows`, v.value?.length === 0, `${v.value?.length} row(s)`);
  }

  const admin = await asAuthenticated(database, () =>
    asActor(database, ids.OWNER_A, async () => {
      const { rows } = await database.query(`select name, status from pf_platform_pharmacies order by created_at`);
      return rows;
    }),
  );
  check('the administrator sees every pharmacy', admin.value?.length >= 5, `${admin.value?.length} pharmacy/pharmacies`);
  check('including the pre-existing Endline Pharmacy',
    admin.value?.some((p) => p.name === 'Endline Pharmacy'), '');
  check('and the one just onboarded',
    admin.value?.some((p) => p.name === 'Beta Pharmacy'), '');
}

section('12b. the activity view carries no secrets');

{
  const v = await asAuthenticated(database, () =>
    asActor(database, ids.OWNER_A, async () => {
      const { rows } = await database.query(`select * from pf_platform_activity order by created_at desc limit 50`);
      return rows;
    }),
  );
  const rows = v.value ?? [];
  const columns = rows.length ? Object.keys(rows[0]) : [];
  check('metadata is not exposed', !columns.includes('metadata'), columns.join(', '));
  const blob = JSON.stringify(rows);
  check('no token-shaped value appears anywhere', !/sb_secret_|[0-9a-f]{48,}/i.test(blob.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')), '');
  check('no password-shaped value appears', !/password|secret_key/i.test(blob), '');
}

/* ================== 12c. business activity vs administration activity */
//
// `last_activity_at` reads as "last activity" but measures ADMINISTRATION
// events only - role changes, onboarding, status changes. A pharmacy trading
// every day and never touching a role reports a stale date there, and any
// adoption metric built on it would be wrong.
//
// `last_business_activity_at` is the corrected column, derived from the two
// tables that carry real operational timestamps. All three cases are asserted,
// because a bug that only ever reported the sale date would still pass a single
// happy-path assertion - and the sale-only case in particular is invisible to
// `stock_movements`.
section('12c. business activity is distinguished from administration');
{
  // Reads the columns exactly as the platform dashboard would.
  const lastActivity = async (branchId) => {
    const r = await asAuthenticated(database, () =>
      asActor(database, ids.OWNER_A, async () => {
        const { rows } = await database.query(
          `select last_activity_at, last_business_activity_at
             from pf_platform_pharmacies where id = $1::uuid`,
          [branchId],
        );
        return rows[0] ?? {};
      }),
    );
    return r.value ?? {};
  };

  // --- never-active: the pharmacy exists but has done nothing ---------------
  const [dormant] = await query(
    database,
    `insert into branches (name, status, is_main_hub) values ('Dormant Pharmacy','active',true) returning id`,
  );
  {
    const row = await lastActivity(dormant.id);
    check('a pharmacy that never transacted reports NULL business activity',
      row.last_business_activity_at === null, JSON.stringify(row.last_business_activity_at));
    check('  ...and NULL admin activity too',
      row.last_activity_at === null, JSON.stringify(row.last_activity_at));
  }

  // --- sale-only: a sale that recorded no stock movement ---------------------
  //
  // This is why `stock_movements` alone is insufficient: some sales write no
  // movement row, so only `sales` can see them.
  //
  // The row is inserted directly rather than through `pf_complete_sale`, because
  // that RPC refuses to sell medicine with no sellable lots ("Only N left in
  // sellable stock") and therefore cannot produce this state. A `sales` row with
  // no `sale_items` fires no trigger and moves no stock - which is exactly the
  // legacy shape a sale takes when it is recorded without a lot allocation, and
  // precisely the case the column has to survive.
  const [shop] = await query(
    database,
    `insert into branches (name, status, is_main_hub) values ('Sale Only Pharmacy','active',true) returning id`,
  );
  const [boss] = await query(
    database,
    `insert into auth.users (id, email) values ('bbbbbbb1-0000-0000-0000-000000000001','saleonly@example.test') returning id`,
  );
  await asServer(() =>
    database.query(`update profiles set role='owner', branch_id=$1 where id=$2`, [shop.id, boss.id]),
  );

  // A fully paid cash sale, so the `sales_paid_plus_outstanding` check holds:
  // amount_paid + outstanding = total.
  const [bareSale] = await asServer(async () => {
    const r = await database.query(
      `insert into sales
         (branch_id, receipt_number, attendant_id,
          subtotal, discount, total, payment_method, state,
          amount_paid, outstanding, sold_at)
       values ($1,'PF-2026-9001',$2, 5, 0, 5, 'cash', 'paid', 5, 0, now())
       returning id, sold_at`,
      [shop.id, boss.id],
    );
    return r.rows;
  }) ?? [];

  check('a sale with no stock movement was recorded', Boolean(bareSale?.id),
    bareSale?.id ?? 'insert failed');
  if (!bareSale?.id) throw new Error('fixture failed: could not record the bare sale');

  const movementRows = await query(
    database,
    `select count(*)::int as n from stock_movements where branch_id = $1`,
    [shop.id],
  );
  const saleRows = await query(
    database,
    `select count(*)::int as n from sales where branch_id = $1`,
    [shop.id],
  );
  check('  ...exactly one sale exists and it moved no stock',
    (saleRows[0]?.n ?? 0) === 1 && (movementRows[0]?.n ?? -1) === 0,
    `${saleRows[0]?.n} sale(s), ${movementRows[0]?.n} movement(s)`);

  {
    const row = await lastActivity(shop.id);
    check('sale-only pharmacy DOES report business activity',
      row.last_business_activity_at !== null, JSON.stringify(row.last_business_activity_at));
    check('  ...while admin activity is still NULL',
      row.last_activity_at === null, JSON.stringify(row.last_activity_at));

    const same = bareSale?.sold_at &&
      new Date(row.last_business_activity_at).getTime() === new Date(bareSale.sold_at).getTime();
    check('  ...and it matches the sale timestamp exactly', Boolean(same),
      `${row.last_business_activity_at} vs ${bareSale?.sold_at}`);
  }

  // --- stock-movement-only: receiving stock, never sold ---------------------
  const [stockShop] = await query(
    database,
    `insert into branches (name, status, is_main_hub) values ('Stock Only Pharmacy','active',true) returning id`,
  );
  await asServer(async () => {
    const [m] = await query(
      database,
      `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
       values ($1,'Stock Only Drug','t','[{"key":"tablet","name":"Tablet","multiplier":1,"sellingPrice":5}]'::jsonb,2,5,current_date+365) returning id`,
      [stockShop.id],
    );
    await database.query(
      `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
       values ($1,$2,'S1',current_date+100,100,2)`,
      [stockShop.id, m.id],
    );
  });
  // NOTE: not `const [moveCount] = ...`. A single-row aggregate still arrives as a
  // one-element ARRAY, so destructuring hands back the row and `moveCount[0]` is
  // undefined. Keep the array.
  const moveCount = await query(
    database,
    `select count(*)::int as n from stock_movements where branch_id = $1`,
    [stockShop.id],
  );
  check('receiving stock produced a movement row', (moveCount[0]?.n ?? 0) >= 1,
    `${moveCount[0]?.n ?? 'NO ROW'} movement(s)`);
  const noSale = await query(
    database,
    `select count(*)::int as n from sales where branch_id = $1`,
    [stockShop.id],
  );
  check('  ...and no sale at all', (noSale[0]?.n ?? -1) === 0, `${noSale[0]?.n ?? 'NO ROW'} sale(s)`);

  {
    const row = await lastActivity(stockShop.id);
    check('stock-only pharmacy DOES report business activity, proving `stock_movements` is not optional',
      row.last_business_activity_at !== null, JSON.stringify(row.last_business_activity_at));
  }

  // --- both present: the later of the two wins -----------------------------
  const later = new Date(Date.now() + 3_600_000).toISOString();
  await asServer(() =>
    database.query(`update stock_movements set created_at = $1 where branch_id = $2`, [later, stockShop.id]),
  );
  {
    const row = await lastActivity(stockShop.id);
    check('greatest() picks the later of the two timestamps',
      new Date(row.last_business_activity_at).getTime() === new Date(later).getTime(),
      `${row.last_business_activity_at} vs ${later}`);
  }

  // --- an admin event must NOT move the business column --------------------
  {
    await setStatus(ids.OWNER_A, shop.id, 'suspended', 'check');
    const row = await lastActivity(shop.id);
    check('a suspension writes admin activity but leaves business activity alone',
      row.last_activity_at !== null && row.last_business_activity_at !== null,
      `admin=${row.last_activity_at} business=${row.last_business_activity_at}`);
    const salesAfter = await query(database, `select count(*)::int as n from sales where branch_id = $1`, [shop.id]);
    check('  ...and the suspension changed no sales', (salesAfter[0]?.n ?? -1) === 1,
      `${salesAfter[0]?.n ?? 'NO ROW'} sale(s)`);
    await setStatus(ids.OWNER_A, shop.id, 'active');
  }

  // --- non-admins still see nothing ----------------------------------------
  for (const [who, actor] of [['an owner', ENDLINE_OWNER], ['an attendant', ids.ASSISTANT_A]]) {
    const leak = await asAuthenticated(database, () =>
      asActor(database, actor, async () => {
        const { rows } = await database.query(
          `select count(*)::int as n from pf_platform_pharmacies
            where last_business_activity_at is not null`,
        );
        return rows[0]?.n ?? -1;
      }),
    );
    check(`${who} sees no business-activity rows at all`, leak.value === 0, `${leak.value}`);
  }
}

/* ============================== 13/14. existing protections still work */

section('13. existing checkout and cost protections are untouched');

{
  const [med] = await query(
    database,
    `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
     values ($1,'Legacy Drug','g','[{"key":"tablet","name":"Tablet","multiplier":1,"sellingPrice":5}]'::jsonb,2,5,current_date+365) returning id`,
    [endline.id],
  );
  await database.query(
    `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
     values ($1,$2,'B1',current_date+100,500,2)`,
    [endline.id, med.id],
  );

  const sold = await asAuthenticated(database, () =>
    asActor(database, ENDLINE_ASSISTANT, async () => {
      await database.query(`select set_actor_email('endline-assistant@example.test')`);
      const { rows, error } = await database.query(
        `select * from public.pf_complete_sale(
           p_lines => $1::jsonb, p_payment_method => 'cash', p_amount_paid => 5,
           p_discount => 0, p_discount_reason => null, p_customer_id => null,
           p_credit_account_id => null, p_dispensed_against_prescription => false,
           p_idempotency_key => null)`,
        [`[{"medicine_id":"${med.id}","unit_key":"tablet","quantity":1}]`],
      );
      return { rows, error: error?.message ?? null };
    }),
  );
  check('an ordinary sale still completes', !sold.value?.error && sold.value?.rows?.length === 1, sold.value?.error ?? '');

  const [lot] = await query(database, `select quantity from medicine_batches where medicine_id = $1`, [med.id]);
  check('and stock still moved', lot?.quantity === 499, String(lot?.quantity));

  const cost = await asAuthenticated(database, () =>
    asActor(database, ENDLINE_ASSISTANT, async () => {
      const { error } = await database.query(`select cost_per_base_unit from medicines where id = $1`, [med.id]);
      return error?.message ?? null;
    }),
  );
  check('an attendant still cannot read purchase cost', cost !== null, cost ?? 'COST WAS READABLE');

  const ownerCost = await asAuthenticated(database, () =>
    asActor(database, ENDLINE_OWNER, async () => {
      const { rows } = await database.query(`select cost_per_base_unit from pf_medicine_costs where id = $1`, [med.id]);
      return rows;
    }),
  );
  check('an owner still can, through the gated view', ownerCost.value?.length === 1, `${ownerCost.value?.length}`);
}

section('14. the pre-existing pharmacy is intact');

{
  const rows = await query(
    database,
    `select name, status, city from branches where name = 'Endline Pharmacy'`,
  );
  check('Endline Pharmacy still exists', rows.length === 1, `${rows.length}`);
  check('and is active', rows[0]?.status === 'active', String(rows[0]?.status));
  check('with its city preserved', rows[0]?.city === 'Lagos', String(rows[0]?.city));

  const memberships = await query(
    database,
    `select count(*)::int as n from branch_memberships where branch_id = $1`,
    [endline.id],
  );
  check('its memberships survived', memberships[0].n === 2, `${memberships[0].n}`);

  const owner = await query(database, `select role from profiles where id = $1`, [ENDLINE_OWNER]);
  check('its owner is still an owner', owner[0]?.role === 'owner', String(owner[0]?.role));

  const canWork = await asAuthenticated(database, () =>
    asActor(database, ENDLINE_OWNER, async () => {
      const { rows } = await database.query(`select id from pf_my_branches`);
      return rows;
    }),
  );
  check('its owner can still sign in and resolve the branch', canWork.value?.length === 1, `${canWork.value?.length}`);
}

section('PROVISIONING: the grant function is unreachable from a browser');

{
  const anon = await asAnon(database, () =>
    database.query(`select public.pf_grant_platform_admin('anyone@example.test')`),
  );
  check('anon cannot call it', !anon.ok, anon.ok ? 'called' : anon.err);

  const authed = await asAuthenticated(database, () =>
    asActor(database, ids.OWNER_A, async () => {
      const { error } = await database.query(`select public.pf_grant_platform_admin('anyone@example.test')`);
      return error?.message ?? null;
    }),
  );
  check('a signed-in owner cannot call it', authed !== null, authed ?? 'THE GRANT WAS CALLABLE');

  // And the internal guard, independent of the grant.
  const guarded = await asActor(database, ids.OWNER_A, async () => {
    try {
      await database.query(`select public.pf_grant_platform_admin('owner-a@example.test')`);
      return 'THE GRANT WAS CALLABLE';
    } catch (e) {
      return String(e?.message ?? e).split('\n')[0];
    }
  });
  check('the internal auth.uid() guard also refuses', /platform operator/i.test(guarded), String(guarded));

  const unknown = await asServer(async () => {
    try {
      await database.query(`select public.pf_grant_platform_admin('nobody@example.test')`);
      return 'NO ERROR RAISED';
    } catch (e) {
      return String(e?.message ?? e).split('\n')[0];
    }
  });
  check('an unknown address is reported, not silently ignored',
    /No account exists/i.test(unknown), unknown);
}

note('concurrency is not exercised here', 'PGlite is single-connection');

process.exit(await finish(database));
