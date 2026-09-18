import { Router } from 'express';
import { authRoutes } from './auth.routes.js';
import { usersRoutes } from './users.routes.js';
import { equipmentRoutes } from './equipment.routes.js';
import { faultsRoutes } from './faults.routes.js';
import { attachmentsRoutes } from './attachments.routes.js';
import { publicRoutes } from './public.routes.js';
import {
  maintenanceRoutes, notificationRoutes, dashboardRoutes, reportRoutes, metaRoutes, partsRoutes, auditRoutes,
} from './misc.routes.js';

/**
 * `/api/v1` surface.  Ordering matters: public routes are mounted before the authenticated
 * group, and every group carries its own guards rather than trusting a global one.
 */
export function apiRouter() {
  const api = Router();

  api.use('/public', publicRoutes);
  api.use('/auth', authRoutes);
  api.use('/users', usersRoutes);
  api.use('/equipment', equipmentRoutes);
  api.use('/faults', faultsRoutes);
  api.use('/maintenance', maintenanceRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/dashboard', dashboardRoutes);
  api.use('/reports', reportRoutes);
  api.use('/reference', metaRoutes);
  api.use('/parts', partsRoutes);
  api.use('/audit', auditRoutes);
  api.use('/attachments', attachmentsRoutes);

  api.get('/', (_req, res) => {
    res.json({
      service: 'BEM-FRS API',
      version: '1.0.0',
      documentation: 'docs/API.md in the repository',
      endpoints: [
        'POST /auth/login', 'POST /auth/logout', 'GET /auth/me', 'POST /auth/change-password',
        'GET|POST /equipment', 'GET|PATCH|DELETE /equipment/:id', 'GET /equipment/:id/qr.png',
        'GET /equipment/:id/history', 'POST /equipment/:id/status', 'POST /equipment/:id/image',
        'GET|POST /faults', 'GET|PATCH /faults/:id', 'POST /faults/:id/assign',
        'POST /faults/:id/transition', 'POST /faults/:id/notes', 'POST /faults/:id/reopen',
        'GET|PUT /faults/:id/repair', 'POST /faults/:id/repair/photos',
        'GET /maintenance/due-board', 'GET|POST /maintenance/schedules', 'POST /maintenance/records',
        'POST /maintenance/reminders', 'GET /maintenance/compliance',
        'GET /dashboard', 'GET /dashboard/risk', 'GET /dashboard/risk/:equipmentId',
        'GET /reports', 'GET /reports/:key', 'GET /reports/export/:key/csv', 'GET /reports/export/:key/print',
        'GET /notifications', 'GET /audit', 'GET /reference/picklists',
      ],
    });
  });

  return api;
}
