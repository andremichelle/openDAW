# Nextcloud future plans

- **Own sample library**: a shared library of samples and soundfonts hosted in the Nextcloud, reused
  across projects and students.
- **Custom Nextcloud app (connector and classroom setup)**: one Nextcloud app that does both jobs.
  First, it bakes in the `opendaw.studio` CORS allowlist, so a school installs it in one click
  instead of the manual WebAppPassword config. Second, it provisions classes (accounts, folders,
  permissions) so teachers avoid the manual Team Folder and ACL setup, and it could expose
  provisioning endpoints so this can be driven from inside openDAW.
