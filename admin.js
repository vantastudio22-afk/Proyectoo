const { db, tx, getSettings, balanceOf } = require('./db');
const { HttpError, v, hashPassword } = require('./lib');
const { role } = require('./auth');
const S = require('./services');
const { rewardView } = require('./points');
const { STATUSES, STATUS_LABELS } = require('./constants');

const SETTING_LIMITS = {
  base_price: [0, 1e7], price_per_km: [0, 1e6], price_per_kg: [0, 1e6], min_price: [0, 1e7], volumetric_divisor: [1000, 20000],
  mult_standard: [0.1, 20], mult_express: [0.1, 20], mult_urgent: [0.1, 20], points_per_100: [0, 1000],
};
function routes(r) {
  const admin = role('admin');

  r.get('/api/admin/stats', admin, () => {
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const byStatus = {};
    for (const s of STATUSES) byStatus[s] = 0;
    for (const x of db.prepare('SELECT status, COUNT(*) c FROM shipments GROUP BY status').all()) byStatus[x.status] = x.c;
    return {
      totals: {
        shipments: one('SELECT COUNT(*) c FROM shipments').c,
        clients: one("SELECT COUNT(*) c FROM users WHERE role='client'").c,
        drivers: one("SELECT COUNT(*) c FROM users WHERE role='driver' AND active=1").c,
        revenue: one("SELECT COALESCE(SUM(price_final),0) s FROM shipments WHERE status='delivered'").s,
        pointsIssued: one("SELECT COALESCE(SUM(points),0) s FROM points_ledger WHERE points>0").s,
        pointsRedeemed: -one("SELECT COALESCE(SUM(points),0) s FROM points_ledger WHERE points<0").s,
      },
      byStatus: STATUSES.map((s) => ({ status: s, label: STATUS_LABELS[s], count: byStatus[s] })),
      perDay: db.prepare("SELECT date(created_at) d, COUNT(*) c FROM shipments WHERE created_at >= date('now','-13 days') GROUP BY d ORDER BY d").all(),
      byService: db.prepare('SELECT service, COUNT(*) c FROM shipments GROUP BY service').all(),
    };
  });

  r.get('/api/admin/shipments', admin, (ctx) => {
    const where = [], args = [];
    if (ctx.query.status && STATUSES.includes(ctx.query.status)) { where.push('s.status=?'); args.push(ctx.query.status); }
    if (ctx.query.q) { where.push('(s.tracking_code LIKE ? OR s.sender_name LIKE ? OR s.receiver_name LIKE ?)'); const q = `%${String(ctx.query.q).slice(0, 50)}%`; args.push(q, q, q); }
    const rows = db.prepare(`SELECT s.*, u.name AS client_name, u.email AS client_email, d.name AS driver_name FROM shipments s
      JOIN users u ON u.id=s.user_id LEFT JOIN users d ON d.id=s.driver_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 300`).all(...args);
    return { shipments: rows.map((x) => ({ ...S.shipmentView(x), clientName: x.client_name, clientEmail: x.client_email, driverName: x.driver_name })) };
  });
  r.patch('/api/admin/shipments/:id/status', admin, (ctx) => {
    const sh = S.setStatus(Number(ctx.params.id), ctx.body.status, ctx.user, v.optStr(ctx.body.note, 'note', { max: 200 }));
    return { shipment: S.shipmentView(sh) };
  });
  r.post('/api/admin/shipments/:id/assign', admin, (ctx) => {
    const driverId = v.num(ctx.body.driverId, 'driverId', { int: true, min: 1, label: 'El repartidor' });
    return { shipment: S.shipmentView(S.assignDriver(Number(ctx.params.id), driverId, ctx.user)) };
  });

  r.get('/api/admin/clients', admin, () => ({
    clients: db.prepare("SELECT id,name,email,phone,active,created_at FROM users WHERE role='client' ORDER BY id DESC LIMIT 500").all()
      .map((c) => ({ ...c, active: !!c.active, createdAt: S.iso(c.created_at), shipments: db.prepare('SELECT COUNT(*) c FROM shipments WHERE user_id=?').get(c.id).c, points: balanceOf(c.id) })),
  }));
  r.patch('/api/admin/users/:id', admin, (ctx) => {
    const id = Number(ctx.params.id);
    if (id === ctx.user.id) throw new HttpError(422, 'No podés desactivar tu propia cuenta');
    const res = db.prepare('UPDATE users SET active=? WHERE id=?').run(ctx.body.active ? 1 : 0, id);
    if (!res.changes) throw new HttpError(404, 'Usuario no encontrado');
    return { ok: true };
  });
  r.post('/api/admin/points/adjust', admin, (ctx) => {
    const userId = v.num(ctx.body.userId, 'userId', { int: true, min: 1, label: 'El cliente' });
    const pts = v.num(ctx.body.points, 'points', { int: true, min: -100000, max: 100000, label: 'Los puntos' });
    const note = v.str(ctx.body.note, 'note', { max: 150, label: 'El motivo' });
    if (pts === 0) throw new HttpError(422, 'Ingresá una cantidad distinta de cero', { field: 'points' });
    return tx(() => {
      if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='client'").get(userId)) throw new HttpError(404, 'Cliente no encontrado');
      if (pts < 0 && balanceOf(userId) + pts < 0) throw new HttpError(422, 'El cliente no tiene esa cantidad de puntos', { field: 'points' });
      db.prepare('INSERT INTO points_ledger(user_id,points,type,note) VALUES (?,?,?,?)').run(userId, pts, pts > 0 ? 'earn' : 'redeem', `Ajuste administrativo: ${note}`);
      return { balance: balanceOf(userId) };
    });
  });

  r.get('/api/admin/drivers', admin, () => ({
    drivers: db.prepare("SELECT id,name,email,phone,active FROM users WHERE role='driver' ORDER BY name").all().map((d) => {
      const loc = db.prepare('SELECT lat,lng,recorded_at FROM driver_locations WHERE driver_id=? ORDER BY id DESC LIMIT 1').get(d.id);
      const age = loc ? Math.round((Date.now() - new Date(loc.recorded_at).getTime()) / 1000) : null;
      return { ...d, active: !!d.active, location: loc ? { lat: loc.lat, lng: loc.lng, recordedAt: loc.recorded_at, ageSeconds: age } : null,
        openShipments: db.prepare("SELECT COUNT(*) c FROM shipments WHERE driver_id=? AND status!='delivered'").get(d.id).c };
    }),
  }));
  r.post('/api/admin/drivers', admin, async (ctx) => {
    const b = ctx.body;
    const email = v.email(b.email);
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'Ya existe una cuenta con ese email', { field: 'email' });
    const id = db.prepare("INSERT INTO users(name,email,password_hash,role,phone) VALUES (?,?,?,'driver',?)")
      .run(v.str(b.name, 'name', { min: 2, max: 100, label: 'El nombre' }), email, await hashPassword(v.password(b.password)), v.optStr(b.phone, 'phone', { max: 30 })).lastInsertRowid;
    return { status: 201, data: { id } };
  });

  r.get('/api/admin/settings', admin, () => ({ settings: getSettings(), limits: SETTING_LIMITS }));
  r.put('/api/admin/settings', admin, (ctx) => {
    const upd = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    tx(() => {
      for (const [k, [min, max]] of Object.entries(SETTING_LIMITS)) {
        if (ctx.body[k] === undefined) continue;
        upd.run(k, String(v.num(ctx.body[k], k, { min, max, label: k })));
      }
    });
    return { settings: getSettings() };
  });

  const parseReward = (b) => ({
    name: v.str(b.name, 'name', { max: 80, label: 'El nombre' }),
    description: v.optStr(b.description, 'description', { max: 200 }) || '',
    cost: v.num(b.pointsCost, 'pointsCost', { int: true, min: 1, max: 1e6, label: 'Los puntos necesarios' }),
    type: v.oneOf(b.discountType, 'discountType', ['percent', 'fixed'], 'El tipo de descuento'),
    value: v.num(b.discountValue, 'discountValue', { min: 0.01, max: b.discountType === 'percent' ? 100 : 1e6, label: 'El descuento' }),
    featured: b.featured ? 1 : 0, active: b.active === false ? 0 : 1,
  });
  r.get('/api/admin/rewards', admin, () => ({ rewards: db.prepare('SELECT * FROM rewards ORDER BY id').all().map((x) => ({ ...rewardView(x), active: !!x.active })) }));
  r.post('/api/admin/rewards', admin, (ctx) => {
    const p = parseReward(ctx.body);
    const id = db.prepare('INSERT INTO rewards(name,description,points_cost,discount_type,discount_value,featured,active) VALUES (?,?,?,?,?,?,?)').run(p.name, p.description, p.cost, p.type, p.value, p.featured, p.active).lastInsertRowid;
    return { status: 201, data: { id } };
  });
  r.put('/api/admin/rewards/:id', admin, (ctx) => {
    const p = parseReward(ctx.body);
    const res = db.prepare('UPDATE rewards SET name=?,description=?,points_cost=?,discount_type=?,discount_value=?,featured=?,active=? WHERE id=?').run(p.name, p.description, p.cost, p.type, p.value, p.featured, p.active, Number(ctx.params.id));
    if (!res.changes) throw new HttpError(404, 'Recompensa no encontrada');
    return { ok: true };
  });
}
module.exports = { routes };
