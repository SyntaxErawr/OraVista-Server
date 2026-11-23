const catalog = require('./service-catalog.json');
const services = catalog.categories.flatMap(category => category.services);
function findService(name) {
    if (typeof name !== 'string') return undefined;
    const normalized = name.trim().toLowerCase();
    return services.find(service => [service.name, service.mobileName].some(value => value.toLowerCase() === normalized));
}
function bookingAmount(name) {
    const service = findService(name);
    if (!service) throw Object.assign(new Error('Choose a service from the current clinic list.'), {statusCode:400});
    // Zero is an unquoted pending estimate, not a free or fully paid service.
    // Staff billing still supplies the actual charge after consultation.
    return service.basePrice ?? 0;
}
module.exports = {catalog, services, findService, bookingAmount};
