"""netviz -- geo-arc kiosk globe."""

# The single source of the version number. pyproject.toml reads it from here
# (`dynamic = ["version"]`), so a release cannot end up with the package and
# the metadata disagreeing -- which is exactly the failure the update check
# would then report to every kiosk as a permanent "update available".
#
# Keep this, the git tag and the GitHub release on the same number.
__version__ = "0.6.0"
