const jwt = require('jsonwebtoken');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Missing Authorization header' });

  const token = header.replace('Bearer ', '');
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, name, role, branch_id, permissions }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Usage: requireRole('super_admin', 'all_branches_manager')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do this' });
    }
    next();
  };
}

// Usage: requirePermission('transfers') — checks the module-access
// list stored on the user, in addition to (or instead of) role.
function requirePermission(moduleName) {
  return (req, res, next) => {
    if (req.user.role === 'super_admin') return next();
    const perms = req.user.permissions || [];
    if (!perms.includes(moduleName)) {
      return res.status(403).json({ error: `No access to module: ${moduleName}` });
    }
    next();
  };
}

module.exports = { authenticate, requireRole, requirePermission };
